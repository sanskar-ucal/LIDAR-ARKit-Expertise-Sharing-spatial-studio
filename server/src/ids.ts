import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const randomId = (prefix: string, bytes = 9): string => `${prefix}${randomBytes(bytes).toString("base64url")}`;

/** 144-bit capability token. */
export const newToken = (): string => randomBytes(18).toString("base64url");

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Human-friendly room code. It is not a secret; joining always needs a token as well. */
export function newRoomCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export const hashToken = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

export function tokenMatches(candidate: string, expectedHash: Buffer): boolean {
  return timingSafeEqual(hashToken(candidate), expectedHash);
}
