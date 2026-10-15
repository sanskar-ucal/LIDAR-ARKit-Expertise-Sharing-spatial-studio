import { networkInterfaces } from "node:os";
import { startServer } from "./app.js";
import { loadConfig } from "./config.js";
import { log, setLogLevel } from "./log.js";

const config = loadConfig();
setLogLevel(config.logLevel);

function lanUrls(port: number): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal) continue;
      // Unreachable from the phone: self-assigned 169.254.x.x and 192.0.0.x (the Mac's internal
      // IPv4-over-IPv6 translation address on IPv6-only networks).
      if (a.family === "IPv4" && !a.address.startsWith("169.254.") && !a.address.startsWith("192.0.0.")) {
        v4.push(`http://${a.address}:${port}`);
      } else if (a.family === "IPv6" && /^[23]/.test(a.address) && v6.length === 0) {
        v6.push(`http://[${a.address}]:${port}`); // first global address; link-local fe80:: needs a zone id
      }
    }
  }
  return v4.length ? v4 : v6;
}

const running = await startServer(config);
log.info(`RoomBridge server listening on ${config.host.includes(":") ? `[${config.host}]` : config.host}:${running.port}`);
const urls = lanUrls(running.port);
for (const url of urls) log.info(`  Same-Wi-Fi URL for the iPhone / Blender / browsers: ${url}`);
if (urls.length === 0) log.warn("  No network address found. Is Wi-Fi connected?");
if (config.serveWeb) log.info("  Serving the built web viewer from web/dist (run `npm run build` first).");

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info("shutting down");
    await running.close();
    process.exit(0);
  });
}
