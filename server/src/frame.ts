export const FRAME_MAGIC = 0x46504252; // "RBPF" read as little-endian uint32
export const FRAME_HEADER_BYTES = 24;

export interface FrameHeader {
  version: number;
  orientation: number;
  flags: number;
  seq: number;
  width: number;
  height: number;
  captureTimeMs: number;
}

export function parseFrameHeader(buf: Buffer): FrameHeader | null {
  if (buf.length < FRAME_HEADER_BYTES + 4) return null;
  if (buf.readUInt32LE(0) !== FRAME_MAGIC) return null;
  const header: FrameHeader = {
    version: buf.readUInt8(4),
    orientation: buf.readUInt8(5),
    flags: buf.readUInt16LE(6),
    seq: buf.readUInt32LE(8),
    width: buf.readUInt16LE(12),
    height: buf.readUInt16LE(14),
    captureTimeMs: buf.readDoubleLE(16),
  };
  if (header.version !== 1 || header.orientation > 3) return null;
  if (header.width < 1 || header.height < 1 || header.width > 4096 || header.height > 4096) return null;
  // JPEG start-of-image marker.
  if (buf[FRAME_HEADER_BYTES] !== 0xff || buf[FRAME_HEADER_BYTES + 1] !== 0xd8) return null;
  return header;
}

export function encodeFrame(h: Omit<FrameHeader, "version">, jpeg: Buffer): Buffer {
  const out = Buffer.alloc(FRAME_HEADER_BYTES + jpeg.length);
  out.writeUInt32LE(FRAME_MAGIC, 0);
  out.writeUInt8(1, 4);
  out.writeUInt8(h.orientation, 5);
  out.writeUInt16LE(h.flags, 6);
  out.writeUInt32LE(h.seq >>> 0, 8);
  out.writeUInt16LE(h.width, 12);
  out.writeUInt16LE(h.height, 14);
  out.writeDoubleLE(h.captureTimeMs, 16);
  jpeg.copy(out, FRAME_HEADER_BYTES);
  return out;
}
