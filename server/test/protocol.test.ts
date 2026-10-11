import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseClientMessage, ProtocolError } from "../src/protocol.js";
import { boot, createRoom, fixtures, TestClient } from "./helpers.js";

describe("shared message fixtures", () => {
  it.each(fixtures.messages.validClient as any[])("valid: $name parses", ({ message }: any) => {
    expect(() => parseClientMessage(JSON.stringify(message))).not.toThrow();
  });

  it("rejects non-JSON and non-objects", () => {
    expect(() => parseClientMessage("{nope")).toThrowError(ProtocolError);
    expect(() => parseClientMessage("[1,2]")).toThrowError(ProtocolError);
  });

  describe("invalid fixtures are rejected by a live server with the documented code", () => {
    let srv: Awaited<ReturnType<typeof boot>>;
    let expert: TestClient;
    beforeAll(async () => {
      srv = await boot();
      const room = await createRoom(srv.base);
      expert = await TestClient.join(srv.ws, room.code, room.expertToken, "Expert");
    });
    afterAll(async () => {
      await expert.close();
      await srv.close();
    });

    it.each(fixtures.messages.invalidClient as any[])("invalid: $name -> $expectedError", async ({ message, expectedError }: any) => {
      const msg = { ...message, roomId: expert.roomId, clientId: expert.clientId };
      expert.ws.send(JSON.stringify(msg));
      const reply = await expert.next((m) => m.type === "error");
      expect(reply.payload.code).toBe(expectedError);
    });
  });
});
