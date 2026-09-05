import { createPublicKey, verify as verifySignature } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { canonicalBytes, fromBase64url, sha256Hex } from "../protocol/index.js";
import {
  ReefInboxConnection,
  ReefProtocolCompatibilityError,
  ReefRelayError,
  createReefWebSocket,
  isRetryableReefRelayFailure,
} from "./transport.js";
import { createClient, signing, ts } from "./transport.test-helpers.js";
import type { RelayFriend } from "./types.js";

function pendingFriend(peer = "bob"): RelayFriend {
  return {
    peer,
    status: "pending",
    initiated_by: peer,
    vouching_mutual: null,
    ed25519_pub: "B".repeat(43),
    x25519_pub: "C".repeat(43),
    key_epoch: 2,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isRetryableReefRelayFailure", () => {
  it("accepts transient relay responses and timeouts", () => {
    expect(isRetryableReefRelayFailure(new ReefRelayError(408, "timeout"))).toBe(true);
    expect(isRetryableReefRelayFailure(new ReefRelayError(429, "rate_limited"))).toBe(true);
    expect(isRetryableReefRelayFailure(new ReefRelayError(503, "unavailable"))).toBe(true);
    expect(
      isRetryableReefRelayFailure(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
    ).toBe(true);
  });

  it("rejects definitive relay and local failures", () => {
    expect(isRetryableReefRelayFailure(new ReefRelayError(401, "unauthorized"))).toBe(false);
    expect(isRetryableReefRelayFailure(new Error("approval store unavailable"))).toBe(false);
  });
});

describe("ReefTransportClient network failures", () => {
  it("normalizes fetch failures without swallowing the cause", async () => {
    const cause = new TypeError("fetch failed");
    const client = createClient(async () => {
      throw cause;
    });

    const error = await client.listFriends().catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      name: "ReefRelayUnavailableError",
      message: "fetch failed",
      cause,
    });
    expect(isRetryableReefRelayFailure(error)).toBe(true);
  });

  it("normalizes connection loss while reading a successful response body", async () => {
    const cause = new TypeError("terminated");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(cause);
        },
      }),
    );
    const client = createClient(async () => response);

    await expect(client.listFriends()).rejects.toMatchObject({
      name: "ReefRelayUnavailableError",
      message: "terminated",
      cause,
    });
  });
});

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
    const client = createClient(fetcher);

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
    const client = createClient(vi.fn() as typeof fetch);
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
      return Response.json({ peer: "bob", status: "active", future: "ignored" });
    };
    const client = createClient(fetcher);
    const friend = pendingFriend();

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

  it("diagnoses an outdated relay without retrying or downgrading the signed request", async () => {
    const calls: RequestInit[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      return Response.json({ error: "invalid_request" }, { status: 400 });
    };
    const client = createClient(fetcher);
    const friend = pendingFriend();

    const error = await client.respondFriend(friend, true).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReefRelayError);
    expect(error).toBeInstanceOf(ReefProtocolCompatibilityError);
    expect(error).toMatchObject({
      status: 400,
      code: "invalid_request",
      upgradeRequired: "reef-relay",
      message:
        "The Reef relay is likely incompatible or outdated. Update OpenClaw and the Reef relay together, then approve the fresh pairing challenge again.",
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(calls[0]?.body as Uint8Array))).toEqual({
      peer: "bob",
      accept: true,
      expected_key_epoch: 2,
      expected_ed25519_pub: "B".repeat(43),
      expected_x25519_pub: "C".repeat(43),
    });
  });

  it("diagnoses an outdated OpenClaw client from the current relay response", async () => {
    const client = createClient(async () =>
      Response.json({ error: "client_upgrade_required" }, { status: 409 }),
    );

    const error = await client
      .respondFriend(pendingFriend(), true)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReefRelayError);
    expect(error).toBeInstanceOf(ReefProtocolCompatibilityError);
    expect(error).toMatchObject({
      status: 409,
      code: "client_upgrade_required",
      upgradeRequired: "openclaw-client",
      message:
        "OpenClaw is outdated for this Reef relay. Update OpenClaw, then approve the fresh pairing challenge again.",
    });
  });

  it.each([
    { name: "an empty 204", response: () => new Response(null, { status: 204 }), accept: true },
    { name: "a primitive", response: () => Response.json("active"), accept: true },
    { name: "a malformed object", response: () => Response.json({ peer: "bob" }), accept: true },
    {
      name: "a different peer",
      response: () => Response.json({ peer: "mallory", status: "active" }),
      accept: true,
    },
    {
      name: "the wrong accepted status",
      response: () => Response.json({ peer: "bob", status: "blocked" }),
      accept: true,
    },
    {
      name: "the wrong rejected status",
      response: () => Response.json({ peer: "bob", status: "active" }),
      accept: false,
    },
  ])("rejects $name before friendship trust can be committed", async ({ response, accept }) => {
    const client = createClient(async () => response());

    await expect(client.respondFriend(pendingFriend(), accept)).rejects.toThrow(
      "invalid Reef relay friendship response",
    );
  });

  it("bumps ts monotonically so identical same-second requests never share a replay key", async () => {
    const seenTs: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      seenTs.push(new Headers(init?.headers).get("x-reef-ts")!);
      return Response.json({ friendships: [] });
    };
    const client = createClient(fetcher);

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
    const client = createClient(async () => response);

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
    const client = createClient(async () => offered.response);

    await expect(client.pull(0)).rejects.toThrow(
      /reef\.relay: JSON response exceeds 16777216 bytes/,
    );
    expect(offered.state.cancelled).toBe(true);
    expect(offered.state.emittedBytes).toBeGreaterThan(SUCCESS_RESPONSE_MAX_BYTES);
    expect(offered.state.emittedBytes).toBeLessThan(SUCCESS_RESPONSE_MAX_BYTES + 1 + 2048);
  });

  it("surfaces relay error JSON exactly at the error byte limit", async () => {
    const body = jsonObjectBodyAtSize(ERROR_RESPONSE_MAX_BYTES, "error");
    const client = createClient(async () => new Response(body, { status: 400 }));

    const error = await client.requestFriend("bob", "code").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ReefRelayError);
    expect(error).toMatchObject({ status: 400, code: undefined });
    expect((error as Error).message).toHaveLength(ERROR_RESPONSE_MAX_BYTES - 12);
    expect(Buffer.byteLength(body)).toBe(ERROR_RESPONSE_MAX_BYTES);
  });

  it("keeps status fallback and cancels oversized error bodies", async () => {
    const offered = createTrackedResponse({
      status: 503,
      chunks: Array.from({ length: 16 }, () => new Uint8Array(8 * 1024).fill(0x78)),
    });
    const client = createClient(async () => offered.response);

    await expect(client.listFriends()).rejects.toMatchObject({
      name: "ReefRelayError",
      status: 503,
      message: "relay HTTP 503",
      code: undefined,
    });
    expect(offered.state.cancelled).toBe(true);
    expect(offered.state.emittedBytes).toBeGreaterThan(64 * 1024);
    expect(offered.state.emittedBytes).toBeLessThan(128 * 1024);
  });

  it("keeps the typed status fallback for malformed error JSON", async () => {
    const client = createClient(async () => new Response("{", { status: 502 }));

    await expect(client.requestFriend("bob", "code")).rejects.toMatchObject({
      name: "ReefRelayError",
      status: 502,
      message: "relay HTTP 502",
      code: undefined,
    });
  });

  it("keeps the status fallback when parsed error JSON has no relay code", async () => {
    const client = createClient(async () => Response.json({ detail: "ignored" }, { status: 400 }));

    await expect(client.requestFriend("bob")).rejects.toMatchObject({
      name: "ReefRelayError",
      status: 400,
      message: "relay HTTP 400",
      code: undefined,
    });
  });
});

describe("ReefTransportClient credential redaction", () => {
  it("redacts setup tokens and bearer sessions from loopback relay errors", async () => {
    const setupToken = "reef.token[abc]+?/";
    const session = `reef-session-${"a".repeat(96)}-tail`;
    const sessionPrefix = session.slice(0, 6);
    const sessionSuffix = session.slice(-4);
    const receivedAuthorization: string[] = [];
    const receivedSignatures: string[] = [];
    const receivedTokens: string[] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const authorization = request.headers.authorization ?? "";
        receivedAuthorization.push(authorization);
        const signatureHeader = request.headers["x-reef-sig"];
        const signature = typeof signatureHeader === "string" ? signatureHeader : "";
        if (signature) {
          receivedSignatures.push(signature);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const token = body ? (JSON.parse(body) as { token?: unknown }).token : undefined;
        if (typeof token === "string") {
          receivedTokens.push(token);
        }
        const reflectedCredential =
          authorization || (typeof token === "string" ? token : "") || signature;
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: `${reflectedCredential} relay rejected`, marker: "safe" }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Reef credential redaction test server did not bind a TCP port");
    }

    const client = createClient(fetch, () => ts, `http://127.0.0.1:${address.port}`);
    try {
      const tokenError = await client.authComplete(setupToken).catch((error: unknown) => error);
      const createHandleError = await client
        .createHandle(session, "approve")
        .catch((error: unknown) => error);
      const sessionError = await client.listOwnHandles(session).catch((error: unknown) => error);
      const signedError = await client.listFriends().catch((error: unknown) => error);

      expect(tokenError).toMatchObject({ name: "ReefRelayError", status: 401 });
      expect(createHandleError).toMatchObject({ name: "ReefRelayError", status: 401 });
      expect(sessionError).toMatchObject({ name: "ReefRelayError", status: 401 });
      expect(tokenError).toMatchObject({ message: expect.stringContaining("relay rejected") });
      expect(createHandleError).toMatchObject({
        message: expect.stringContaining("relay rejected"),
      });
      expect(sessionError).toMatchObject({ message: expect.stringContaining("relay rejected") });
      expect(signedError).toMatchObject({
        name: "ReefRelayError",
        status: 401,
        message: expect.stringContaining("relay rejected"),
      });
      expect((tokenError as Error).message).not.toContain(setupToken);
      expect((createHandleError as Error).message).not.toContain(session);
      expect((sessionError as Error).message).not.toContain(session);
      expect((createHandleError as Error).message).not.toContain(sessionPrefix);
      expect((createHandleError as Error).message).not.toContain(sessionSuffix);
      expect((sessionError as Error).message).not.toContain(sessionPrefix);
      expect((sessionError as Error).message).not.toContain(sessionSuffix);
      expect(receivedAuthorization).toContain(`Bearer ${session}`);
      expect(receivedSignatures).toHaveLength(1);
      expect(receivedSignatures[0]).toBeTruthy();
      expect((signedError as Error).message).not.toContain(receivedSignatures[0]);
      expect(receivedTokens).toContain(setupToken);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("redacts signed body credentials across bounded error text", async () => {
    const code = "friend.code[123]+?/";
    const prefix = "x".repeat(32_760);
    const suffix = "y".repeat(32);
    const receivedBodies: string[] = [];
    const client = createClient(async (_url, init) => {
      const body = init?.body;
      receivedBodies.push(
        body instanceof Uint8Array
          ? new TextDecoder().decode(body)
          : typeof body === "string"
            ? body
            : "",
      );
      const responseBody = JSON.stringify({ error: `${prefix}${code}${suffix}` });
      const splitAt = responseBody.indexOf(code) + Math.floor(code.length / 2);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(responseBody.slice(0, splitAt)));
            controller.enqueue(new TextEncoder().encode(responseBody.slice(splitAt)));
            controller.close();
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });

    const error = await client.requestFriend("bob", code).catch((failure: unknown) => failure);

    expect(error).toMatchObject({ name: "ReefRelayError", status: 401 });
    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0]).toContain(`"code":"${code}"`);
    expect((error as Error).message).not.toContain(code);
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
  const client = createClient(
    async () => Response.json({ entries: [], cursor: 0 }),
    () => ts,
    `http://127.0.0.1:${address.port}`,
  );
  const inbox = new ReefInboxConnection(
    client,
    async (received) => {
      entries.push(...received);
      abort.abort();
    },
    createReefWebSocket,
    {
      onState: (state) => {
        states.push(state);
        if (state === "disconnected") {
          abort.abort();
        }
      },
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

describe("createReefWebSocket handshake deadline", () => {
  it("errors when the relay accepts TCP but never completes the upgrade", async () => {
    const peers = new Set<import("node:net").Socket>();
    const server = http.createServer();
    server.on("connection", (socket) => {
      peers.add(socket);
      socket.once("close", () => peers.delete(socket));
    });
    server.on("upgrade", () => {
      // Leave the HTTP upgrade pending until the client deadline aborts it.
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const { port } = server.address() as AddressInfo;
      const socket = createReefWebSocket(`ws://127.0.0.1:${port}`, {
        handshakeTimeoutMs: 50,
      }) as WebSocket;
      const [error] = await once(socket, "error");

      expect(error).toMatchObject({ message: "Opening handshake has timed out" });
    } finally {
      for (const peer of peers) {
        peer.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
