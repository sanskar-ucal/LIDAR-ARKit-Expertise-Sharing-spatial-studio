// Preview frame header (PROTOCOL.md, "Preview socket"): 24 bytes little-endian, then JPEG.

export const FRAME_HEADER_BYTES = 24;
const MAGIC = 0x46504252; // "RBPF"

export interface FrameHeader {
  orientation: 0 | 1 | 2 | 3; // portrait, portraitUpsideDown, landscapeLeft, landscapeRight
  synthetic: boolean;
  trackingLimited: boolean;
  seq: number;
  width: number;
  height: number;
  captureTimeMs: number;
}

export function parseFrame(buf: ArrayBuffer): { header: FrameHeader; jpeg: Uint8Array } | null {
  if (buf.byteLength < FRAME_HEADER_BYTES + 4) return null;
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== MAGIC || v.getUint8(4) !== 1) return null;
  const orientation = v.getUint8(5);
  if (orientation > 3) return null;
  const flags = v.getUint16(6, true);
  const jpeg = new Uint8Array(buf, FRAME_HEADER_BYTES);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  return {
    header: {
      orientation: orientation as FrameHeader["orientation"],
      synthetic: (flags & 1) !== 0,
      trackingLimited: (flags & 2) !== 0,
      seq: v.getUint32(8, true),
      width: v.getUint16(12, true),
      height: v.getUint16(14, true),
      captureTimeMs: v.getFloat64(16, true),
    },
    jpeg,
  };
}
