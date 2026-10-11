import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "./config.js";
import { createHttpHandler } from "./http.js";
import { RoomRegistry } from "./rooms.js";
import { attachWebSockets } from "./ws.js";

export interface RunningServer {
  server: Server;
  rooms: RoomRegistry;
  port: number;
  close(): Promise<void>;
}

export function startServer(config: Config): Promise<RunningServer> {
  const rooms = new RoomRegistry(config);
  const server = createServer(createHttpHandler(config, rooms));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const sockets = attachWebSockets(server, config, rooms);
  const sweeper = setInterval(() => rooms.sweep(), 30_000);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        rooms,
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweeper);
            for (const room of rooms.all()) room.end("server_shutdown");
            sockets.close();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
