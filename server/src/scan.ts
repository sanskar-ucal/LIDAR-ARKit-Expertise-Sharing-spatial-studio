import { LIMITS } from "./config.js";
import { randomId } from "./ids.js";
import { ProtocolError } from "./protocol.js";

export const SCAN_MAGIC = 0x43534252; // "RBSC" little-endian
export const SCAN_HEADER_BYTES = 20;

export interface ScanBeginInput {
  originEpoch: number;
  chunkCount: number;
  totalBytes: number;
  vertexCount: number;
  triangleCount: number;
  synthetic: boolean;
}

export interface ScanMeta {
  scanId: string;
  originEpoch: number;
  vertexCount: number;
  triangleCount: number;
  bytes: number;
  synthetic: boolean;
  committedAt: number;
}

export const expectedScanBytes = (vertices: number, triangles: number): number =>
  SCAN_HEADER_BYTES + vertices * 12 + triangles * 12;

export class ScanStaging {
  readonly uploadId = randomId("u_");
  readonly chunks: (Buffer | undefined)[];
  readonly createdAt: number;

  constructor(
    readonly input: ScanBeginInput,
    now: number,
  ) {
    this.chunks = new Array(input.chunkCount).fill(undefined);
    this.createdAt = now;
  }

  static validateBegin(raw: unknown, currentEpoch: number): ScanBeginInput {
    const r = raw as Record<string, unknown>;
    const ints = ["originEpoch", "chunkCount", "totalBytes", "vertexCount", "triangleCount"] as const;
    for (const k of ints) {
      if (typeof r?.[k] !== "number" || !Number.isInteger(r[k]) || (r[k] as number) < 0) {
        throw new ProtocolError("bad_request", `${k} must be a non-negative integer`);
      }
    }
    const input: ScanBeginInput = {
      originEpoch: r.originEpoch as number,
      chunkCount: r.chunkCount as number,
      totalBytes: r.totalBytes as number,
      vertexCount: r.vertexCount as number,
      triangleCount: r.triangleCount as number,
      synthetic: r.synthetic === true,
    };
    if (input.originEpoch !== currentEpoch) throw new ProtocolError("stale_epoch", "Scan belongs to an old AR origin");
    if (input.chunkCount < 1 || input.chunkCount > LIMITS.scanMaxChunks) {
      throw new ProtocolError("too_large", `chunkCount must be 1..${LIMITS.scanMaxChunks}`);
    }
    if (input.totalBytes > LIMITS.scanMaxBytes) throw new ProtocolError("too_large", "Scan exceeds 8 MiB");
    if (input.vertexCount < 3 || input.vertexCount > LIMITS.scanMaxVertices) {
      throw new ProtocolError("too_large", `vertexCount must be 3..${LIMITS.scanMaxVertices}`);
    }
    if (input.triangleCount < 1 || input.triangleCount > LIMITS.scanMaxTriangles) {
      throw new ProtocolError("too_large", `triangleCount must be 1..${LIMITS.scanMaxTriangles}`);
    }
    if (input.totalBytes !== expectedScanBytes(input.vertexCount, input.triangleCount)) {
      throw new ProtocolError("bad_request", "totalBytes does not match vertex/triangle counts");
    }
    return input;
  }

  putChunk(index: number, data: Buffer): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.chunks.length) {
      throw new ProtocolError("bad_request", "Chunk index out of range");
    }
    if (data.length === 0 || data.length > LIMITS.scanChunkMaxBytes) {
      throw new ProtocolError("too_large", "Chunk must be 1..256 KiB");
    }
    this.chunks[index] = data;
  }

  /** Assemble and fully validate. Throws without side effects on any problem. */
  assemble(): Buffer {
    const missing = this.chunks.findIndex((c) => c === undefined);
    if (missing >= 0) throw new ProtocolError("bad_request", `Chunk ${missing} missing`);
    const buf = Buffer.concat(this.chunks as Buffer[]);
    if (buf.length !== this.input.totalBytes) throw new ProtocolError("bad_request", "Assembled size mismatch");
    validateScanBuffer(buf, this.input);
    return buf;
  }
}

export function validateScanBuffer(buf: Buffer, expect: ScanBeginInput): void {
  if (buf.length < SCAN_HEADER_BYTES || buf.readUInt32LE(0) !== SCAN_MAGIC) {
    throw new ProtocolError("bad_request", "Not an RBSC scan");
  }
  if (buf.readUInt16LE(4) !== 1) throw new ProtocolError("bad_request", "Unsupported scan version");
  const synthetic = (buf.readUInt16LE(6) & 1) === 1;
  const epoch = buf.readUInt32LE(8);
  const v = buf.readUInt32LE(12);
  const t = buf.readUInt32LE(16);
  if (epoch !== expect.originEpoch || v !== expect.vertexCount || t !== expect.triangleCount || synthetic !== expect.synthetic) {
    throw new ProtocolError("bad_request", "Scan header does not match upload metadata");
  }
  if (buf.length !== expectedScanBytes(v, t)) throw new ProtocolError("bad_request", "Scan length mismatch");
  const max = LIMITS.scanMaxCoordinate;
  let off = SCAN_HEADER_BYTES;
  for (let i = 0; i < v * 3; i++, off += 4) {
    const f = buf.readFloatLE(off);
    if (!Number.isFinite(f) || Math.abs(f) > max) throw new ProtocolError("bad_request", "Scan vertex out of range");
  }
  for (let i = 0; i < t * 3; i++, off += 4) {
    if (buf.readUInt32LE(off) >= v) throw new ProtocolError("bad_request", "Scan index out of range");
  }
}

/** Builds an RBSC buffer. Used by tests and the synthetic sample-room tooling. */
export function encodeScan(epoch: number, vertices: number[], indices: number[], synthetic = false): Buffer {
  const v = vertices.length / 3;
  const t = indices.length / 3;
  const buf = Buffer.alloc(expectedScanBytes(v, t));
  buf.writeUInt32LE(SCAN_MAGIC, 0);
  buf.writeUInt16LE(1, 4);
  buf.writeUInt16LE(synthetic ? 1 : 0, 6);
  buf.writeUInt32LE(epoch, 8);
  buf.writeUInt32LE(v, 12);
  buf.writeUInt32LE(t, 16);
  let off = SCAN_HEADER_BYTES;
  for (const f of vertices) (buf.writeFloatLE(f, off), (off += 4));
  for (const i of indices) (buf.writeUInt32LE(i, off), (off += 4));
  return buf;
}
