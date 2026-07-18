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
// A reconnect recovers dropped frames from REST, so keep only a bounded live
// window while catch-up or entry dispatch is busy. At the payload cap this
// limits retained frame data to roughly 16 MiB per connection.
const REEF_INBOX_LIVE_BUFFER_MAX_ENTRIES = 256;
// Stalled TCP peers that never complete the HTTP upgrade would otherwise hang
// forever — ws defaults to no handshakeTimeout. Match sibling channel WS budgets.
const REEF_WS_HANDSHAKE_MS = 30_000;

export class ReefRelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReefRelayError";
  }
}

export function isDefinitiveReefRegistrationFailure(error: unknown): boolean {
  return (
    error instanceof ReefRelayError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export function isReefOwnershipRejection(error: unknown): boolean {
  return error instanceof ReefRelayError && error.message === "unknown_handle";
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
  pull(after: number, signal?: AbortSignal): Promise<{ entries: InboxEntry[]; cursor: number }> {
    return this.signed("GET", `/v1/mail?after=${after}`, undefined, signal);
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

  async signed<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const bytes = body === undefined ? new Uint8Array() : utf8(JSON.stringify(body));
    const auth = this.auth(path, bytes, method);
    return await this.request(
      method,
      path,
      bytes,
      {
        "x-reef-handle": this.handle,
        "x-reef-ts": String(auth.ts),
        "x-reef-sig": auth.signature,
      },
      signal,
    );
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
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetcher(new URL(path, this.relayUrl), {
      method,
      headers: { ...headers, ...(bytes.length ? { "content-type": "application/json" } : {}) },
      ...(bytes.length ? { body: bytes as BodyInit } : {}),
      ...(signal ? { signal } : {}),
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
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: { error?: unknown; message?: string }) => void,
  ): void;
  close(): void;
}

interface ReefInboxConnectionOptions {
  initialCursor?: number;
  persistCursor?: (cursor: number) => void;
  onState?: (state: "connected" | "disconnected") => void;
  onError?: (error: Error) => void;
}

export function createReefWebSocket(
  url: string,
  options: { handshakeTimeoutMs?: number } = {},
): WebSocketLike {
  return new WebSocket(url, {
    maxPayload: REEF_RELAY_WEBSOCKET_MAX_PAYLOAD_BYTES,
    handshakeTimeout: options.handshakeTimeoutMs ?? REEF_WS_HANDSHAKE_MS,
  });
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
  private cursor: number;
  // Entry dispatch remains serial across socket replacements. A closed socket
  // can be replaced immediately while its in-flight pull finishes, without a
  // second connection concurrently delivering the same durable cursor range.
  private processing = Promise.resolve();
  private stopped = false;
  constructor(
    readonly client: ReefTransportClient,
    readonly onEntries: (entries: InboxEntry[]) => Promise<void>,
    readonly webSocketFactory: (url: string) => WebSocketLike,
    readonly options: ReefInboxConnectionOptions = {},
  ) {
    const initialCursor = options.initialCursor ?? 0;
    if (!Number.isSafeInteger(initialCursor) || initialCursor < 0) {
      throw new Error("invalid Reef inbox cursor");
    }
    this.cursor = initialCursor;
  }

  async start(signal?: AbortSignal): Promise<void> {
    let delay = 250;
    for (;;) {
      if (this.stopped || signal?.aborted) {
        // An error callback may abort after live() already detached its listener.
        // Do not return control until every older socket's serial work is quiescent.
        await this.processing;
        return;
      }
      try {
        // Establish the live feed first. live() buffers frames behind the REST
        // catch-up, so a slow backlog cannot make a healthy socket look offline.
        await this.live(signal, () => {
          // A socket that completed catch-up is healthy. Future disconnects
          // start from the short delay instead of inheriting old failures.
          delay = 250;
        });
      } catch (error) {
        this.options.onError?.(asError(error));
        await abortableSleep(delay, signal);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async drain(signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted();
      const page = await this.client.pull(this.cursor, signal);
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(page.cursor) || page.cursor < this.cursor) {
        throw new Error("invalid Reef relay inbox cursor");
      }
      const previous = this.cursor;
      await this.processEntries(page.entries, page.cursor, signal);
      if (!page.entries.length || this.cursor === previous) {
        return;
      }
    }
  }

  private async processEntries(
    entries: readonly InboxEntry[],
    cursor?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    let highestSequence = 0;
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry.seq) || entry.seq < 1) {
        throw new Error("invalid Reef relay inbox sequence");
      }
      highestSequence = Math.max(highestSequence, entry.seq);
    }
    // Validate the complete REST page before dispatch. Delivery and cursor
    // persistence are irreversible, so a contradictory page must have no side effects.
    if (cursor !== undefined && entries.length > 0 && cursor !== highestSequence) {
      throw new Error("Reef relay inbox cursor does not match its entries");
    }
    const fresh = entries.toSorted((left, right) => left.seq - right.seq);
    if (fresh.length === 0) {
      if (cursor !== undefined) {
        this.advanceCursor(cursor);
      }
      return;
    }
    for (const entry of fresh) {
      if (entry.seq <= this.cursor) {
        continue;
      }
      signal?.throwIfAborted();
      await this.onEntries([entry]);
      // A completed handler has consumed the entry even if shutdown arrived
      // while it ran. Persist it before the next abort check to avoid replay.
      this.advanceCursor(entry.seq);
    }
  }

  private advanceCursor(cursor: number): void {
    if (cursor <= this.cursor) {
      return;
    }
    this.options.persistCursor?.(cursor);
    this.cursor = cursor;
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const scheduled = this.processing.then(task);
    // Keep the shared serial tail usable after a socket-local failure. The
    // caller still observes scheduled's rejection and tears down that socket.
    this.processing = scheduled.catch(() => {});
    return scheduled;
  }

  private live(signal?: AbortSignal, onReady?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.webSocketFactory(this.client.websocketUrl());
      const workAbort = new AbortController();
      // Emit each state transition at most once per socket and never after this
      // invocation settles, so late events from an abandoned socket cannot
      // overwrite the lifecycle state of its replacement (or of a stopped channel).
      let finished = false;
      let disconnected = false;
      let aborting = false;
      let opened = false;
      let catchUpPending = false;
      let pumpScheduled = false;
      const bufferedEntries: InboxEntry[] = [];
      const abortListener = () => {
        if (finished) {
          return;
        }
        aborting = true;
        markDisconnected();
        socket.close();
        // Older socket work can still own the shared serial tail. Waiting here
        // prevents a replacement channel from dispatching the same cursor range.
        void this.processing.then(
          () => finish(),
          () => finish(),
        );
      };
      const finish = (error?: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        signal?.removeEventListener("abort", abortListener);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const markDisconnected = () => {
        if (disconnected) {
          return;
        }
        disconnected = true;
        bufferedEntries.length = 0;
        workAbort.abort();
        this.options.onState?.("disconnected");
      };
      const disconnect = (error?: Error) => {
        if (finished) {
          return;
        }
        markDisconnected();
        // An abort waits for the class-wide serial tail. A close event emitted
        // synchronously by socket.close() must not finish this invocation early.
        if (aborting) {
          return;
        }
        finish(error);
        if (error) {
          socket.close();
        }
      };
      const pump = () => {
        if (
          disconnected ||
          !opened ||
          pumpScheduled ||
          (!catchUpPending && bufferedEntries.length === 0)
        ) {
          return;
        }
        pumpScheduled = true;
        const scheduled = this.serialize(async () => {
          if (disconnected) {
            return;
          }
          if (catchUpPending) {
            catchUpPending = false;
            await this.drain(workAbort.signal);
            onReady?.();
          }
          while (bufferedEntries.length > 0) {
            if (disconnected) {
              return;
            }
            const entry = bufferedEntries.shift();
            if (!entry) {
              return;
            }
            await this.processEntries([entry], undefined, workAbort.signal);
          }
        });
        void scheduled.then(
          () => {
            pumpScheduled = false;
            pump();
          },
          (error: unknown) => {
            pumpScheduled = false;
            if (!disconnected) {
              disconnect(asError(error));
            }
          },
        );
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      socket.addEventListener("open", () => {
        if (disconnected) {
          return;
        }
        opened = true;
        catchUpPending = true;
        this.options.onState?.("connected");
        pump();
      });
      socket.addEventListener("message", (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as { type?: string; entry?: InboxEntry };
          if (frame.type !== "entry" || !frame.entry) {
            return;
          }
          if (bufferedEntries.length >= REEF_INBOX_LIVE_BUFFER_MAX_ENTRIES) {
            disconnect(
              new Error("Reef inbox live buffer overflow; reconnecting for REST recovery"),
            );
            return;
          }
          bufferedEntries.push(frame.entry);
          pump();
        } catch (error) {
          disconnect(asError(error));
        }
      });
      // Socket state is independent of a slow REST pull or entry handler. Mark
      // it disconnected now; the shared serial tail preserves ordered recovery.
      socket.addEventListener("close", (event) => {
        if (aborting || finished) {
          return;
        }
        disconnect(reefInboxCloseError(event));
      });
      socket.addEventListener("error", (event) =>
        disconnect(new Error(event.message?.trim() || "reef inbox socket error")),
      );
      if (signal?.aborted) {
        abortListener();
      }
    });
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function reefInboxCloseError(event: { code?: number; reason?: string }): Error {
  const code = Number.isInteger(event.code) ? ` code=${event.code}` : "";
  const reason = event.reason?.trim() ? ` reason=${event.reason.trim()}` : "";
  return new Error(`reef inbox socket closed unexpectedly${code}${reason}`);
}
