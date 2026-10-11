import type { Config } from "./config.js";
import { newRoomCode, newToken, randomId } from "./ids.js";
import { log } from "./log.js";
import { Room } from "./room.js";

export interface CreatedRoom {
  roomId: string;
  code: string;
  hostToken: string;
  expertToken: string;
  viewerToken: string;
  viewerLink: string;
  expertLink: string;
  expiresAt: number;
}

export class RoomRegistry {
  private byId = new Map<string, Room>();
  private byCode = new Map<string, Room>();
  private tickets = new Map<string, { room: Room; clientId: string }>();

  constructor(
    private config: Config,
    private now: () => number = Date.now,
  ) {}

  create(hostName: string, baseUrl: string): CreatedRoom {
    let code = newRoomCode();
    while (this.byCode.has(code)) code = newRoomCode();
    const tokens = { host: newToken(), expert: newToken(), viewer: newToken() };
    const room = new Room(randomId("r_", 12), code, hostName, tokens, this.config.roomMaxTtlMs, this.now);
    room.onEnded = (r) => this.remove(r);
    room.onTicket = (ticket, r, clientId) => {
      if (clientId) this.tickets.set(ticket, { room: r, clientId });
      else this.tickets.delete(ticket);
    };
    this.byId.set(room.id, room);
    this.byCode.set(code, room);
    log.info("room created", { room: code });
    return {
      roomId: room.id,
      code,
      hostToken: tokens.host,
      expertToken: tokens.expert,
      viewerToken: tokens.viewer,
      viewerLink: `${baseUrl}/r/${code}#t=${tokens.viewer}`,
      expertLink: `${baseUrl}/r/${code}#t=${tokens.expert}`,
      expiresAt: room.expiresAt,
    };
  }

  get(idOrCode: string): Room | undefined {
    return this.byId.get(idOrCode) ?? this.byCode.get(idOrCode.toUpperCase());
  }

  byTicket(ticket: string): { room: Room; clientId: string } | undefined {
    return this.tickets.get(ticket);
  }

  private remove(room: Room): void {
    this.byId.delete(room.id);
    this.byCode.delete(room.code);
    for (const [t, v] of this.tickets) if (v.room === room) this.tickets.delete(t);
  }

  sweep(): void {
    for (const room of [...this.byId.values()]) {
      if (room.sweep(this.config.roomIdleTtlMs)) room.end("expired");
    }
  }

  all(): Room[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }
}
