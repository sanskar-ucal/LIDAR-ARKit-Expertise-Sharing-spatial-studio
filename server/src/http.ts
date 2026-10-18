import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { LIMITS, VOICE_MIME, type Config } from "./config.js";
import { log } from "./log.js";
import { ProtocolError, type Role } from "./protocol.js";
import { WindowLimiter } from "./ratelimit.js";
import type { RoomRegistry } from "./rooms.js";
import type { Room } from "./room.js";
import { ScanStaging } from "./scan.js";
import { randomId } from "./ids.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const STATUS: Record<string, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  stale_epoch: 409,
  room_ended: 410,
  too_large: 413,
  rate_limited: 429,
};

export function clientIp(req: IncomingMessage, config: Config): string {
  if (config.trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(data);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof ProtocolError) {
    send(res, STATUS[err.code] ?? 400, { error: { code: err.code, message: err.message } });
  } else {
    log.error("http handler error", { error: String(err) });
    send(res, 500, { error: { code: "internal", message: "Internal error" } });
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > limit) {
      reject(new ProtocolError("too_large", `Body exceeds ${limit} bytes`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new ProtocolError("too_large", `Body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  const buf = await readBody(req, limit);
  try {
    const v = JSON.parse(buf.toString("utf8") || "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new ProtocolError("bad_request", "Body must be a JSON object");
  }
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(\S+)$/.exec(h);
  if (!m) throw new ProtocolError("unauthorized", "Missing bearer token");
  return m[1]!;
}

function authorize(room: Room | undefined, req: IncomingMessage, allowed: Role[]): Room {
  if (!room || room.ended) throw new ProtocolError("not_found", "Room not found");
  const role = room.roleForToken(bearer(req));
  if (!role) throw new ProtocolError("unauthorized", "Invalid credential");
  if (!allowed.includes(role)) throw new ProtocolError("forbidden", `${role} may not do this`);
  return room;
}

const HOST_HEADER_RE = /^[A-Za-z0-9.\-:[\]]{1,255}$/;

function baseUrl(req: IncomingMessage, config: Config): string {
  if (config.publicUrl) return config.publicUrl;
  const host = req.headers.host ?? "localhost";
  if (!HOST_HEADER_RE.test(host)) throw new ProtocolError("bad_request", "Bad Host header");
  const proto = config.trustProxy && req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

export function createHttpHandler(config: Config, rooms: RoomRegistry) {
  const createLimiter = new WindowLimiter(10, 10 * 60_000);
  const scanLimiter = new WindowLimiter(200, 60_000);
  const voiceLimiter = new WindowLimiter(120, 60_000);
  const webRoot = resolve(config.webDist);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/api/health") return send(res, 200, { ok: true, rooms: rooms.size, protocolVersion: 1 });

    if (path === "/api/rooms" && method === "POST") {
      if (!createLimiter.allow(clientIp(req, config))) throw new ProtocolError("rate_limited", "Too many rooms created");
      const body = await readJson(req);
      const hostName = typeof body.hostName === "string" ? body.hostName.trim().slice(0, 40) : "";
      if (!hostName) throw new ProtocolError("bad_request", "hostName is required");
      return send(res, 201, rooms.create(hostName, baseUrl(req, config)));
    }

    const scan = /^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/scan(?:\/(begin)|\/([A-Za-z0-9_-]{1,64})\/(chunks)\/(\d{1,3})|\/([A-Za-z0-9_-]{1,64})\/(commit))?$/.exec(path);
    if (scan) {
      if (!scanLimiter.allow(clientIp(req, config))) throw new ProtocolError("rate_limited", "Too many scan requests");
      const room = rooms.get(scan[1]!);
      if (scan[2] === "begin" && method === "POST") {
        const r = authorize(room, req, ["host"]);
        const input = ScanStaging.validateBegin(await readJson(req), r.originEpoch);
        r.staging = new ScanStaging(input, Date.now());
        return send(res, 201, { uploadId: r.staging.uploadId });
      }
      if (scan[4] === "chunks" && method === "PUT") {
        const r = authorize(room, req, ["host"]);
        if (!r.staging || r.staging.uploadId !== scan[3]) throw new ProtocolError("not_found", "Unknown upload");
        const staging = r.staging;
        const data = await readBody(req, LIMITS.scanChunkMaxBytes);
        staging.putChunk(Number(scan[5]), data);
        return send(res, 200, { ok: true });
      }
      if (scan[7] === "commit" && method === "POST") {
        const r = authorize(room, req, ["host"]);
        const staging = r.staging;
        if (!staging || staging.uploadId !== scan[6]) throw new ProtocolError("not_found", "Unknown upload");
        if (staging.input.originEpoch !== r.originEpoch) {
          r.staging = null;
          throw new ProtocolError("stale_epoch", "AR origin changed during upload");
        }
        const data = staging.assemble();
        const meta = {
          scanId: randomId("s_"),
          originEpoch: staging.input.originEpoch,
          vertexCount: staging.input.vertexCount,
          triangleCount: staging.input.triangleCount,
          bytes: data.length,
          synthetic: staging.input.synthetic,
          committedAt: Date.now(),
        };
        r.commitScan(meta, data);
        return send(res, 200, { scan: meta });
      }
      if (!scan[2] && !scan[4] && !scan[7] && method === "GET") {
        const r = authorize(room, req, ["host", "expert"]);
        if (!r.scan) throw new ProtocolError("not_found", "No committed scan yet");
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": r.scan.data.length,
          "cache-control": "no-store",
          "x-rb-origin-epoch": String(r.scan.meta.originEpoch),
          "x-rb-scan-id": r.scan.meta.scanId,
        });
        res.end(r.scan.data);
        return;
      }
      throw new ProtocolError("not_found", "Unknown scan route");
    }

    const voice = /^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/voice(?:\/([A-Za-z0-9_-]{1,64}))?$/.exec(path);
    if (voice) {
      if (!voiceLimiter.allow(clientIp(req, config))) throw new ProtocolError("rate_limited", "Too many voice requests");
      const room = rooms.get(voice[1]!);
      if (!voice[2] && method === "POST") {
        // Push-to-talk clip from the novice or the expert; attached to a chat message with comment.add.
        const r = authorize(room, req, ["host", "expert"]);
        const mime = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        if (!VOICE_MIME.has(mime)) throw new ProtocolError("bad_request", "Unsupported audio type");
        const data = await readBody(req, LIMITS.voiceMaxBytes);
        if (data.length === 0) throw new ProtocolError("bad_request", "Empty voice clip");
        const role = r.roleForToken(bearer(req))!;
        return send(res, 201, { clipId: r.addVoiceClip(role, mime, data) });
      }
      if (voice[2] && method === "GET") {
        const r = authorize(room, req, ["host", "expert", "viewer"]);
        const clip = r.getVoiceClip(voice[2]);
        if (!clip) throw new ProtocolError("not_found", "Voice note not found (it may have expired)");
        res.writeHead(200, { "content-type": clip.mime, "content-length": clip.data.length, "cache-control": "no-store" });
        res.end(clip.data);
        return;
      }
      throw new ProtocolError("not_found", "Unknown voice route");
    }

    if (path.startsWith("/api/")) throw new ProtocolError("not_found", "Unknown API route");

    if ((method === "GET" || method === "HEAD") && config.serveWeb) return serveStatic(path, res);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }

  function serveStatic(path: string, res: ServerResponse): void {
    const indexFile = join(webRoot, "index.html");
    if (!existsSync(indexFile)) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("Web viewer not built. Run `npm run build` (or use `npm run dev` and open the Vite URL).");
      return;
    }
    let file = normalize(join(webRoot, decodeURIComponent(path)));
    if (!file.startsWith(webRoot)) file = indexFile;
    if (!existsSync(file) || statSync(file).isDirectory()) file = indexFile; // SPA fallback (/r/CODE)
    const ext = extname(file);
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": file.includes(`${join("dist", "assets")}`) ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    createReadStream(file).pipe(res);
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    route(req, res).catch((err) => sendError(res, err));
  };
}
