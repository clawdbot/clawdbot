import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import WebSocket from "ws";
import { sha256Hex, signDeviceRequest, utf8 } from "../protocol/index.js";
import type { Envelope, SignedReceipt } from "../protocol/index.js";
import type { InboxEntry, ReefKeys, RelayFriend } from "./types.js";

type FetchLike = typeof fetch;

// Relay JSON is untrusted network input. Cap success bodies at the shared
// provider default and keep error bodies smaller so a hostile relay cannot
// force unbounded allocation through response.json().
const REEF_RELAY_JSON_MAX_BYTES = 16 * 1024 * 1024;
const REEF_RELAY_ERROR_JSON_MAX_BYTES = 64 * 1024;
// Relay envelopes are capped at 48 KiB. Leave room for inbox metadata while
// rejecting oversized or compressed frames before ws materializes the message.
const REEF_RELAY_WEBSOCKET_MAX_PAYLOAD_BYTES = 64 * 1024;

export class ReefRelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReefRelayError";
  }
}

export class ReefTransportClient {
  // Ed25519 is deterministic: identical (method, path, ts, body) requests produce
  // identical signatures, which collide with the relay's replay key. Keep ts
  // strictly monotonic per client so back-to-back identical requests stay unique.
  private lastTs = 0;

  constructor(
    readonly relayUrl: string,
    readonly handle: string,
    readonly keys: ReefKeys,
    readonly fetcher: FetchLike = fetch,
    readonly clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async authStart(email: string): Promise<{ status: string; magicLink?: string }> {
    return await this.unsigned("POST", "/v1/auth/start", { email });
  }

  async authComplete(token: string): Promise<{ session: string; expires: number }> {
    return await this.unsigned("POST", "/v1/auth/complete", { token });
  }

  async createHandle(
    session: string,
    requestPolicy: string,
  ): Promise<{ handle: string; key_epoch: number }> {
    return await this.unsigned(
      "POST",
      "/v1/handles",
      {
        handle: this.handle,
        ed25519_pub: this.keys.signing.publicKey,
        x25519_pub: this.keys.encryption.publicKey,
        request_policy: requestPolicy,
      },
      { authorization: `Bearer ${session}` },
    );
  }

  listOwnHandles(
    session: string,
  ): Promise<{ handles: Array<{ handle: string; key_epoch: number; request_policy: string }> }> {
    return this.unsigned("GET", "/v1/handles", undefined, { authorization: `Bearer ${session}` });
  }

  mintFriendCode(): Promise<{ code: string; expires: number }> {
    return this.signed("POST", "/v1/friend-codes");
  }
  requestFriend(to: string, code?: string): Promise<{ status: string }> {
    return this.signed("POST", "/v1/friends/request", code ? { to, code } : { to });
  }
  respondFriend(friend: RelayFriend, accept: boolean): Promise<{ peer: string; status: string }> {
    return this.signed("POST", "/v1/friends/respond", {
      peer: friend.peer,
      accept,
      expected_key_epoch: friend.key_epoch,
      expected_ed25519_pub: friend.ed25519_pub,
      expected_x25519_pub: friend.x25519_pub,
    });
  }
  listFriends(): Promise<{ friendships: RelayFriend[] }> {
    return this.signed("GET", "/v1/friends");
  }
  removeFriend(peer: string): Promise<void> {
    return this.signed("DELETE", `/v1/friends/${encodeURIComponent(peer)}`);
  }
  sendEnvelope(peer: string, envelope: Envelope): Promise<{ id: string; status: string }> {
    return this.signed("POST", `/v1/mail/${encodeURIComponent(peer)}`, envelope);
  }
  acknowledge(peer: string, id: string, receipt: SignedReceipt): Promise<{ result: string }> {
    return this.signed("POST", `/v1/mail/${encodeURIComponent(peer)}/ack`, { id, receipt });
  }
  pull(after: number): Promise<{ entries: InboxEntry[]; cursor: number }> {
    return this.signed("GET", `/v1/mail?after=${after}`);
  }

  websocketUrl(): string {
    const path = "/v1/mail/ws";
    const auth = this.auth(path, new Uint8Array(), "GET");
    const url = new URL(path, this.relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("handle", this.handle);
    url.searchParams.set("ts", String(auth.ts));
    url.searchParams.set("sig", auth.signature);
    return url.toString();
  }

  async signed<T>(method: string, path: string, body?: unknown): Promise<T> {
    const bytes = body === undefined ? new Uint8Array() : utf8(JSON.stringify(body));
    const auth = this.auth(path, bytes, method);
    return await this.request(method, path, bytes, {
      "x-reef-handle": this.handle,
      "x-reef-ts": String(auth.ts),
      "x-reef-sig": auth.signature,
    });
  }

  private auth(path: string, bytes: Uint8Array, method: string): { ts: number; signature: string } {
    const ts = Math.max(this.clock(), this.lastTs + 1);
    this.lastTs = ts;
    const signature = signDeviceRequest(
      {
        method: method.toUpperCase(),
        path,
        ts,
        bodySha256: sha256Hex(bytes),
      },
      this.keys.signing.secretKey,
    );
    return { ts, signature };
  }

  private async unsigned<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const bytes = body === undefined ? new Uint8Array() : utf8(JSON.stringify(body));
    return await this.request(method, path, bytes, headers);
  }

  private async request<T>(
    method: string,
    path: string,
    bytes: Uint8Array,
    headers: Record<string, string>,
  ): Promise<T> {
    const response = await this.fetcher(new URL(path, this.relayUrl), {
      method,
      headers: { ...headers, ...(bytes.length ? { "content-type": "application/json" } : {}) },
      ...(bytes.length ? { body: bytes as BodyInit } : {}),
    });
    if (!response.ok) {
      let message = `relay HTTP ${response.status}`;
      try {
        const parsed = await readProviderJsonResponse<{ error?: string }>(
          response,
          "reef.relay.error",
          { maxBytes: REEF_RELAY_ERROR_JSON_MAX_BYTES },
        );
        if (typeof parsed.error === "string" && parsed.error) {
          message = parsed.error;
        }
      } catch {
        // Keep the status fallback when the error body is missing, malformed,
        // or oversized; callers still get a typed ReefRelayError.
      }
      throw new ReefRelayError(response.status, message);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return await readProviderJsonResponse<T>(response, "reef.relay", {
      maxBytes: REEF_RELAY_JSON_MAX_BYTES,
    });
  }
}

export interface WebSocketLike {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  close(): void;
}

export function createReefWebSocket(url: string): WebSocketLike {
  return new WebSocket(url, { maxPayload: REEF_RELAY_WEBSOCKET_MAX_PAYLOAD_BYTES });
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class ReefInboxConnection {
  private cursor = 0;
  private stopped = false;
  constructor(
    readonly client: ReefTransportClient,
    readonly onEntries: (entries: InboxEntry[]) => Promise<void>,
    readonly webSocketFactory: (url: string) => WebSocketLike,
    readonly onState?: (state: "connected" | "disconnected") => void,
  ) {}

  async start(signal?: AbortSignal): Promise<void> {
    let delay = 250;
    for (;;) {
      if (this.stopped || signal?.aborted) {
        return;
      }
      try {
        await this.drain();
        await this.live(signal);
        delay = 250;
      } catch {
        await abortableSleep(delay, signal);
        // oxlint-disable-next-line no-useless-assignment -- Read by the next iteration's backoff sleep.
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async drain(): Promise<void> {
    while (true) {
      const page = await this.client.pull(this.cursor);
      if (page.entries.length) {
        await this.onEntries(page.entries);
      }
      const previous = this.cursor;
      this.cursor = page.cursor;
      if (!page.entries.length || this.cursor === previous) {
        return;
      }
    }
  }

  private live(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.webSocketFactory(this.client.websocketUrl());
      // Emit each state transition at most once per socket and never after this
      // invocation settles, so late events from an abandoned socket cannot
      // overwrite the lifecycle state of its replacement (or of a stopped channel).
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.onState?.("disconnected");
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      signal?.addEventListener(
        "abort",
        () => {
          socket.close();
          settle();
        },
        { once: true },
      );
      socket.addEventListener("open", () => {
        if (!settled) {
          this.onState?.("connected");
        }
      });
      socket.addEventListener("message", (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as { type?: string; entry?: InboxEntry };
          if (frame.type !== "entry" || !frame.entry) {
            return;
          }
          this.cursor = Math.max(this.cursor, frame.entry.seq);
          void this.onEntries([frame.entry]).catch((error: unknown) =>
            settle(error instanceof Error ? error : new Error(String(error))),
          );
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.addEventListener("close", () => settle());
      socket.addEventListener("error", () => settle(new Error("reef inbox socket error")));
    });
  }
}
