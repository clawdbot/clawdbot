import { createPublicKey, verify as verifySignature } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { canonicalBytes, fromBase64url, sha256Hex } from "../protocol/index.js";
import {
  ReefInboxConnection,
  ReefRelayError,
  ReefTransportClient,
  createReefWebSocket,
} from "./transport.js";
import type { ReefKeys, RelayFriend } from "./types.js";

const ts = 1_752_300_000;
const signing = {
  secretKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
};
const keys: ReefKeys = {
  signing,
  encryption: {
    secretKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  auditKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  replayKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  keyEpoch: 1,
};

function verifyRelaySignature(
  signature: string,
  input: { method: string; path: string; ts: number; bodySha256: string },
): boolean {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(fromBase64url(signing.publicKey))]),
    format: "der",
    type: "spki",
  });
  return verifySignature(
    null,
    canonicalBytes(input),
    publicKey,
    Buffer.from(fromBase64url(signature)),
  );
}

describe("ReefTransportClient device authentication", () => {
  it("signs the relay canonical REST path including its query and emits auth headers", async () => {
    const calls: Array<[URL | RequestInfo, RequestInit | undefined]> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return Response.json({ entries: [], cursor: 5 });
    };
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      fetcher,
      () => ts,
    );

    await expect(client.pull(5)).resolves.toEqual({ entries: [], cursor: 5 });

    const [requestUrl, init] = calls[0]!;
    expect(requestUrl instanceof URL ? requestUrl.href : requestUrl).toBe(
      "https://relay.example/v1/mail?after=5",
    );
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-reef-handle")).toBe("alice");
    expect(headers.get("x-reef-ts")).toBe(String(ts));
    expect(headers.get("x-reef-sig")).toBe(
      "1Zx-WD8JygVzq8pdTWULPiEZyoLuoJ1zyokkDRGlPWu_6fAKxEfJHPZkCQaZ8DIS4LERDqeh2z6-qlw7BtcoDw",
    );

    const canonical = {
      method: "GET",
      path: "/v1/mail?after=5",
      ts,
      bodySha256: sha256Hex(new Uint8Array()),
    };
    expect(new TextDecoder().decode(canonicalBytes(canonical))).toBe(
      '{"bodySha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","method":"GET","path":"/v1/mail?after=5","ts":1752300000}',
    );
    expect(verifyRelaySignature(headers.get("x-reef-sig")!, canonical)).toBe(true);
  });

  it("puts WebSocket auth in the query but signs the bare relay path", () => {
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      vi.fn() as typeof fetch,
      () => ts,
    );
    const url = new URL(client.websocketUrl());

    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v1/mail/ws");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      handle: "alice",
      ts: String(ts),
      sig: "teC4QkpLUCMghGA-PkBGBMZFPxNeERmNfGCivaxpYhL8q81v6ReHRKEq2ZVvOd-FG3d3BbMjk-FcvoKjW5kwAA",
    });
    expect(
      verifyRelaySignature(url.searchParams.get("sig")!, {
        method: "GET",
        path: "/v1/mail/ws",
        ts,
        bodySha256: sha256Hex(new Uint8Array()),
      }),
    ).toBe(true);
  });

  it("binds friendship responses to the exact listed peer key snapshot", async () => {
    const calls: RequestInit[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      return Response.json({ peer: "bob", status: "active" });
    };
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      fetcher,
      () => ts,
    );
    const friend: RelayFriend = {
      peer: "bob",
      status: "pending",
      initiated_by: "bob",
      vouching_mutual: null,
      ed25519_pub: "B".repeat(43),
      x25519_pub: "C".repeat(43),
      key_epoch: 2,
    };

    await expect(client.respondFriend(friend, true)).resolves.toEqual({
      peer: "bob",
      status: "active",
    });
    expect(JSON.parse(new TextDecoder().decode(calls[0]?.body as Uint8Array))).toEqual({
      peer: "bob",
      accept: true,
      expected_key_epoch: 2,
      expected_ed25519_pub: "B".repeat(43),
      expected_x25519_pub: "C".repeat(43),
    });
  });

  it("bumps ts monotonically so identical same-second requests never share a replay key", async () => {
    const seenTs: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      seenTs.push(new Headers(init?.headers).get("x-reef-ts")!);
      return Response.json({ friendships: [] });
    };
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      fetcher,
      () => ts,
    );

    await client.listFriends();
    await client.listFriends();
    await client.listFriends();

    expect(seenTs).toEqual([String(ts), String(ts + 1), String(ts + 2)]);
    expect(new Set(seenTs).size).toBe(3);
  });
});

const SUCCESS_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const ERROR_RESPONSE_MAX_BYTES = 64 * 1024;

function jsonObjectBodyAtSize(bytes: number, field: "pad" | "error"): string {
  const prefix = `{"${field}":"`;
  const suffix = `"}`;
  return `${prefix}${"x".repeat(bytes - prefix.length - suffix.length)}${suffix}`;
}

function createTrackedResponse(params: { status: number; chunks: Uint8Array[] }): {
  response: Response;
  state: { emittedBytes: number; cancelled: boolean };
} {
  const state = { emittedBytes: 0, cancelled: false };
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = params.chunks[index++];
      if (!chunk) {
        controller.close();
        return;
      }
      state.emittedBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    response: new Response(body, {
      status: params.status,
      headers: { "content-type": "application/json" },
    }),
    state,
  };
}

describe("ReefTransportClient response body bounds", () => {
  it("accepts success JSON exactly at the byte limit", async () => {
    const body = jsonObjectBodyAtSize(SUCCESS_RESPONSE_MAX_BYTES, "pad");
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      async () => response,
      () => ts,
    );

    const result = await client.pull(0);
    const pad = (result as unknown as { pad: string }).pad;
    expect(pad).toHaveLength(SUCCESS_RESPONSE_MAX_BYTES - 10);
    expect(pad[0]).toBe("x");
    expect(pad.at(-1)).toBe("x");
    expect(Buffer.byteLength(body)).toBe(SUCCESS_RESPONSE_MAX_BYTES);
    expect(cancelled).toBe(false);
  });

  it("cancels success JSON when a chunk crosses the byte limit", async () => {
    const offered = createTrackedResponse({
      status: 200,
      chunks: [
        new Uint8Array(SUCCESS_RESPONSE_MAX_BYTES - 1).fill(0x78),
        new Uint8Array(2).fill(0x78),
        new Uint8Array(1024).fill(0x78),
        new Uint8Array(1024).fill(0x78),
      ],
    });
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      async () => offered.response,
      () => ts,
    );

    await expect(client.pull(0)).rejects.toThrow(
      /reef\.relay: JSON response exceeds 16777216 bytes/,
    );
    expect(offered.state.cancelled).toBe(true);
    expect(offered.state.emittedBytes).toBeGreaterThan(SUCCESS_RESPONSE_MAX_BYTES);
    expect(offered.state.emittedBytes).toBeLessThan(SUCCESS_RESPONSE_MAX_BYTES + 1 + 2048);
  });

  it("surfaces relay error JSON exactly at the error byte limit", async () => {
    const body = jsonObjectBodyAtSize(ERROR_RESPONSE_MAX_BYTES, "error");
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      async () => new Response(body, { status: 400 }),
      () => ts,
    );

    const error = await client.requestFriend("bob", "code").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ReefRelayError);
    expect(error).toMatchObject({ status: 400 });
    expect((error as Error).message).toHaveLength(ERROR_RESPONSE_MAX_BYTES - 12);
    expect(Buffer.byteLength(body)).toBe(ERROR_RESPONSE_MAX_BYTES);
  });

  it("keeps status fallback and cancels oversized error bodies", async () => {
    const offered = createTrackedResponse({
      status: 503,
      chunks: Array.from({ length: 16 }, () => new Uint8Array(8 * 1024).fill(0x78)),
    });
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      async () => offered.response,
      () => ts,
    );

    await expect(client.listFriends()).rejects.toMatchObject({
      name: "ReefRelayError",
      status: 503,
      message: "relay HTTP 503",
    });
    expect(offered.state.cancelled).toBe(true);
    expect(offered.state.emittedBytes).toBeGreaterThan(64 * 1024);
    expect(offered.state.emittedBytes).toBeLessThan(128 * 1024);
  });

  it("keeps the typed status fallback for malformed error JSON", async () => {
    const client = new ReefTransportClient(
      "https://relay.example",
      "alice",
      keys,
      async () => new Response("{", { status: 502 }),
      () => ts,
    );

    await expect(client.requestFriend("bob", "code")).rejects.toMatchObject({
      name: "ReefRelayError",
      status: 502,
      message: "relay HTTP 502",
    });
  });
});

const INBOX_WEBSOCKET_MAX_PAYLOAD_BYTES = 64 * 1024;

function inboxFrameAtSize(bytes: number): string {
  const prefix =
    '{"type":"entry","entry":{"seq":1,"peer":"bob","id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","kind":"receipt","receipt":{"pad":"';
  const suffix = '"},"ts":1752300000}}';
  return `${prefix}${"x".repeat(bytes - prefix.length - suffix.length)}${suffix}`;
}

async function deliverInboxFrame(frame: string): Promise<{
  entries: unknown[];
  states: string[];
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("WebSocket test server did not bind a TCP port");
  }
  const entries: unknown[] = [];
  const states: string[] = [];
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 2_000);
  server.once("connection", (socket) => socket.send(frame));
  const client = new ReefTransportClient(
    `http://127.0.0.1:${address.port}`,
    "alice",
    keys,
    async () => Response.json({ entries: [], cursor: 0 }),
    () => ts,
  );
  const inbox = new ReefInboxConnection(
    client,
    async (received) => {
      entries.push(...received);
      abort.abort();
    },
    createReefWebSocket,
    (state) => {
      states.push(state);
      if (state === "disconnected") {
        abort.abort();
      }
    },
  );

  try {
    await inbox.start(abort.signal);
  } finally {
    clearTimeout(timeout);
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
  return { entries, states };
}

describe("ReefInboxConnection response frame bounds", () => {
  it("accepts a relay frame exactly at the payload limit", async () => {
    const frame = inboxFrameAtSize(INBOX_WEBSOCKET_MAX_PAYLOAD_BYTES);

    const result = await deliverInboxFrame(frame);

    expect(Buffer.byteLength(frame)).toBe(INBOX_WEBSOCKET_MAX_PAYLOAD_BYTES);
    expect(result.entries).toHaveLength(1);
    expect(result.states).toContain("connected");
  });

  it("rejects a relay frame above the payload limit before dispatch", async () => {
    const frame = inboxFrameAtSize(INBOX_WEBSOCKET_MAX_PAYLOAD_BYTES + 1);

    const result = await deliverInboxFrame(frame);

    expect(Buffer.byteLength(frame)).toBe(INBOX_WEBSOCKET_MAX_PAYLOAD_BYTES + 1);
    expect(result.entries).toEqual([]);
    expect(result.states).toEqual(["connected", "disconnected"]);
  });
});
