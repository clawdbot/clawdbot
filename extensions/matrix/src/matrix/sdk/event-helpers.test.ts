import type { MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { buildHttpError, matrixEventToRaw, parseMxc } from "./event-helpers.js";

describe("event-helpers", () => {
  it("parses mxc URIs", () => {
    expect(parseMxc("mxc://server.example/media-id")).toEqual({
      server: "server.example",
      mediaId: "media-id",
    });
    expect(parseMxc("not-mxc")).toBeNull();
  });

  it("builds HTTP errors from JSON and plain text payloads", () => {
    const fromJson = buildHttpError(403, JSON.stringify({ error: "forbidden" }));
    expect(fromJson.message).toBe("forbidden");
    expect(fromJson.statusCode).toBe(403);

    const fromText = buildHttpError(500, "internal failure");
    expect(fromText.message).toBe("internal failure");
    expect(fromText.statusCode).toBe(500);
  });

  it("serializes Matrix events and resolves state key from available sources", () => {
    const viaGetter = {
      getId: () => "$1",
      getSender: () => "@alice:example.org",
      getType: () => "m.room.member",
      getTs: () => 1000,
      getContent: () => ({ membership: "join" }),
      getUnsigned: () => ({ age: 1 }),
      getStateKey: () => "@alice:example.org",
    } as unknown as MatrixEvent;
    expect(matrixEventToRaw(viaGetter).state_key).toBe("@alice:example.org");

    const viaWire = {
      getId: () => "$2",
      getSender: () => "@bob:example.org",
      getType: () => "m.room.member",
      getTs: () => 2000,
      getContent: () => ({ membership: "join" }),
      getUnsigned: () => ({}),
      getStateKey: () => undefined,
      getWireContent: () => ({ state_key: "@bob:example.org" }),
    } as unknown as MatrixEvent;
    expect(matrixEventToRaw(viaWire).state_key).toBe("@bob:example.org");

    const viaRaw = {
      getId: () => "$3",
      getSender: () => "@carol:example.org",
      getType: () => "m.room.member",
      getTs: () => 3000,
      getContent: () => ({ membership: "join" }),
      getUnsigned: () => ({}),
      getStateKey: () => undefined,
      event: { state_key: "@carol:example.org" },
    } as unknown as MatrixEvent;
    expect(matrixEventToRaw(viaRaw).state_key).toBe("@carol:example.org");
  });
});
