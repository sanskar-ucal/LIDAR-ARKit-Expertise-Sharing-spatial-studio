import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(here, "..");
export const REPO_ROOT = resolve(SERVER_ROOT, "..");

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const [, key, raw] = m;
    if (key && process.env[key] === undefined) process.env[key] = raw!.replace(/^["']|["']$/g, "");
  }
}

loadDotEnv(resolve(SERVER_ROOT, ".env"));

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in ${name}`);
  return n;
}

export interface Config {
  host: string;
  port: number;
  publicUrl: string;
  serveWeb: boolean;
  webDist: string;
  roomIdleTtlMs: number;
  roomMaxTtlMs: number;
  trustProxy: boolean;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: process.env.HOST || "0.0.0.0",
    port: num("PORT", 8787),
    publicUrl: (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),
    serveWeb: (process.env.SERVE_WEB ?? "1") !== "0",
    webDist: resolve(REPO_ROOT, "web", "dist"),
    roomIdleTtlMs: num("ROOM_IDLE_TTL_MS", 30 * 60_000),
    roomMaxTtlMs: num("ROOM_MAX_TTL_MS", 12 * 3_600_000),
    trustProxy: process.env.TRUST_PROXY === "1",
    logLevel: (process.env.LOG_LEVEL as Config["logLevel"]) || "info",
    ...overrides,
  };
}

export const LIMITS = {
  controlMaxBytes: 64 * 1024,
  previewMaxBytes: 512 * 1024,
  previewMaxFps: 15,
  previewViewerBufferBytes: 256 * 1024,
  previewLateJoinMaxAgeMs: 3_000,
  scanChunkMaxBytes: 256 * 1024,
  scanMaxChunks: 64,
  scanMaxBytes: 8 * 1024 * 1024,
  scanMaxVertices: 200_000,
  scanMaxTriangles: 400_000,
  scanStagingTtlMs: 120_000,
  scanMaxCoordinate: 50,
  maxObjects: 50,
  maxComments: 200,
  snapshotComments: 100,
  dedupeEntries: 1000,
  maxHosts: 1,
  maxExperts: 2,
  maxViewers: 8,
  resumeGraceMs: 60_000,
  authTimeoutMs: 5_000,
  heartbeatMs: 15_000,
  msgRatePerSec: 40,
  msgBurst: 80,
  commentsPerWindow: 5,
  commentWindowMs: 10_000,
} as const;
