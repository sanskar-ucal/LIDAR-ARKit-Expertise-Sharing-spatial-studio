import { networkInterfaces } from "node:os";
import { startServer } from "./app.js";
import { loadConfig } from "./config.js";
import { log, setLogLevel } from "./log.js";

const config = loadConfig();
setLogLevel(config.logLevel);

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

const running = await startServer(config);
log.info(`RoomBridge server listening on ${config.host}:${running.port}`);
for (const ip of lanAddresses()) log.info(`  Same-Wi-Fi URL for the iPhone / Blender / browsers: http://${ip}:${running.port}`);
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
