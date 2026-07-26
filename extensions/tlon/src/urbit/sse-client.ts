// Tlon plugin module implements sse client behavior.
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { ensureUrbitChannelOpen, pokeUrbitChannel, scryUrbitPath } from "./channel-ops.js";
import { getUrbitContext, normalizeUrbitCookie } from "./context.js";
import { UrbitHttpError } from "./errors.js";
import { urbitFetch } from "./fetch.js";

type UrbitSseLogger = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type UrbitSseOptions = {
  ship?: string;
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  onReconnect?: (client: UrbitSSEClient) => Promise<void> | void;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  logger?: UrbitSseLogger;
};

const MAX_SSE_PAYLOAD_BYTES = 16 * 1024 * 1024;

function parseUrbitSsePayload(data: string): { id?: number; json?: unknown; response?: string } {
  if (Buffer.byteLength(data, "utf8") > MAX_SSE_PAYLOAD_BYTES) {
    throw new Error("Tlon Urbit SSE payload exceeds 16 MiB limit");
  }
  try {
    return JSON.parse(data) as { id?: number; json?: unknown; response?: string };
  } catch (cause) {
    throw new Error("Tlon Urbit SSE event was malformed JSON", { cause });
  }
}

function parseUrbitSseEventId(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export class UrbitSSEClient {
  url: string;
  cookie: string;
  ship: string;
  channelId: string;
  channelUrl: string;
  subscriptions: Array<{
    id: number;
    action: "subscribe";
    ship: string;
    app: string;
    path: string;
  }> = [];
  eventHandlers = new Map<
    number,
    {
      event?: (data: unknown) => Promise<void> | void;
      err?: (error: unknown) => void;
      quit?: () => void;
    }
  >();
  aborted = false;
  streamController: AbortController | null = null;
  onReconnect: UrbitSseOptions["onReconnect"] | null;
  autoReconnect: boolean;
  reconnectAttempts = 0;
  maxReconnectAttempts: number;
  reconnectDelay: number;
  maxReconnectDelay: number;
  isConnected = false;
  logger: UrbitSseLogger;
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  streamRelease: (() => Promise<void>) | null = null;

  // Event ack tracking keeps each HTTP channel's delivered window bounded.
  private lastHeardEventId = -1;
  private lastAcknowledgedEventId = -1;
  private readonly ackThreshold = 20;

  constructor(url: string, cookie: string, options: UrbitSseOptions = {}) {
    const ctx = getUrbitContext(url, options.ship);
    this.url = ctx.baseUrl;
    this.cookie = normalizeUrbitCookie(cookie);
    this.ship = ctx.ship;
    this.channelId = `${Math.floor(Date.now() / 1000)}-${randomUUID()}`;
    this.channelUrl = new URL(`/~/channel/${this.channelId}`, this.url).toString();
    this.onReconnect = options.onReconnect ?? null;
    this.autoReconnect = options.autoReconnect !== false;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.reconnectDelay = resolveTimerTimeoutMs(options.reconnectDelay, 1000);
    this.maxReconnectDelay = resolveTimerTimeoutMs(options.maxReconnectDelay, 30000);
    this.logger = options.logger ?? {};
    this.ssrfPolicy = options.ssrfPolicy;
    this.lookupFn = options.lookupFn;
    this.fetchImpl = options.fetchImpl;
  }

  private channelRequestContext() {
    return {
      baseUrl: this.url,
      cookie: this.cookie,
      ship: this.ship,
      channelId: this.channelId,
      ssrfPolicy: this.ssrfPolicy,
      lookupFn: this.lookupFn,
      fetchImpl: this.fetchImpl,
    };
  }

  private resetChannelIdentity(): void {
    this.channelId = `${Math.floor(Date.now() / 1000)}-${randomUUID()}`;
    this.channelUrl = new URL(`/~/channel/${this.channelId}`, this.url).toString();
    this.lastHeardEventId = -1;
    this.lastAcknowledgedEventId = -1;
  }

  private async createCurrentChannel(): Promise<void> {
    await ensureUrbitChannelOpen(this.channelRequestContext(), {
      createBody: this.subscriptions,
      createAuditContext: "tlon-urbit-channel-create",
    });
  }

  async subscribe(params: {
    app: string;
    path: string;
    event?: (data: unknown) => Promise<void> | void;
    err?: (error: unknown) => void;
    quit?: () => void;
  }) {
    const subId = this.subscriptions.length + 1;
    const subscription = {
      id: subId,
      action: "subscribe",
      ship: this.ship,
      app: params.app,
      path: params.path,
    } as const;

    this.subscriptions.push(subscription);
    this.eventHandlers.set(subId, { event: params.event, err: params.err, quit: params.quit });

    if (this.isConnected) {
      try {
        await this.sendSubscription(subscription);
      } catch (error) {
        const handler = this.eventHandlers.get(subId);
        handler?.err?.(error);
      }
    }
    return subId;
  }

  private async sendSubscription(subscription: {
    id: number;
    action: "subscribe";
    ship: string;
    app: string;
    path: string;
  }) {
    const { response, release } = await this.putChannelPayload([subscription], {
      timeoutMs: 30_000,
      auditContext: "tlon-urbit-subscribe",
    });

    try {
      if (!response.ok && response.status !== 204) {
        const errorText = await readResponseTextLimited(response, 16 * 1024).catch(() => "");
        throw new Error(
          `Subscribe failed: ${response.status}${errorText ? ` - ${errorText}` : ""}`,
        );
      }
    } finally {
      await release();
    }
  }

  async connect() {
    // A fresh HTTP channel owns an independent event-id and ack sequence.
    this.lastHeardEventId = -1;
    this.lastAcknowledgedEventId = -1;
    await this.createCurrentChannel();

    await this.openStream();
    this.isConnected = true;
    this.reconnectAttempts = 0;
  }

  async openStream() {
    // Use AbortController with manual timeout so we only abort during initial connection,
    // not after the SSE stream is established and actively streaming.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);

    this.streamController = controller;

    let stream: Awaited<ReturnType<typeof urbitFetch>>;
    try {
      stream = await urbitFetch({
        baseUrl: this.url,
        path: `/~/channel/${this.channelId}`,
        init: {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            Cookie: this.cookie,
          },
        },
        ssrfPolicy: this.ssrfPolicy,
        lookupFn: this.lookupFn,
        fetchImpl: this.fetchImpl,
        signal: controller.signal,
        auditContext: "tlon-urbit-sse-stream",
      });
    } finally {
      // The deadline only covers waiting for response headers. Always disarm it
      // before response handling so failed connects cannot retain the process.
      clearTimeout(timeoutId);
    }

    const { response, release } = stream;
    this.streamRelease = release;

    if (!response.ok) {
      this.streamRelease = null;
      await release();
      throw new UrbitHttpError({ operation: "Stream connection", status: response.status });
    }

    this.processStream(response.body).catch((error: unknown) => {
      if (!this.aborted) {
        this.logger.error?.(`Stream error: ${String(error)}`);
        for (const { err } of this.eventHandlers.values()) {
          err?.(error);
        }
      }
    });
  }

  async processStream(body: unknown) {
    if (!body) {
      return;
    }
    // Bridge DOM fetch stream types to Node's stream/web declaration on newer TS/node combos.
    const stream =
      body instanceof ReadableStream
        ? Readable.fromWeb(body as never)
        : (body as NodeJS.ReadableStream);
    const decoder = new TextDecoder();
    let buffer = "";
    let bufferBytes = 0;
    let pendingDelimiterNewline = false;

    const appendPending = (text: string) => {
      const previousCodeUnit = buffer.charCodeAt(buffer.length - 1);
      const firstCodeUnit = text.charCodeAt(0);
      const joinsSurrogatePair =
        previousCodeUnit >= 0xd800 &&
        previousCodeUnit <= 0xdbff &&
        firstCodeUnit >= 0xdc00 &&
        firstCodeUnit <= 0xdfff;
      // Buffer.byteLength counts either lone surrogate as three bytes. When
      // chunks join a pair, correct the retained total to the combined four bytes.
      const nextBytes =
        bufferBytes + Buffer.byteLength(text, "utf8") - (joinsSurrogatePair ? 2 : 0);
      if (nextBytes > MAX_SSE_PAYLOAD_BYTES) {
        throw new Error("Tlon Urbit SSE stream buffer exceeded 16 MiB limit");
      }
      buffer += text;
      bufferBytes = nextBytes;
    };
    const consumeText = async (text: string) => {
      let offset = 0;
      if (pendingDelimiterNewline && text.length > 0) {
        pendingDelimiterNewline = false;
        if (text.startsWith("\n")) {
          await this.processEvent(buffer);
          buffer = "";
          bufferBytes = 0;
          offset = 1;
        } else {
          // A trailing newline stays outside the budget until the next byte
          // distinguishes an event delimiter from retained event data.
          appendPending("\n");
        }
      }
      while (offset < text.length) {
        const eventEnd = text.indexOf("\n\n", offset);
        if (eventEnd === -1) {
          const endsWithNewline = text.endsWith("\n");
          appendPending(text.slice(offset, endsWithNewline ? -1 : undefined));
          pendingDelimiterNewline = endsWithNewline;
          return;
        }
        appendPending(text.slice(offset, eventEnd));
        await this.processEvent(buffer);
        buffer = "";
        bufferBytes = 0;
        offset = eventEnd + 2;
      }
    };

    try {
      for await (const chunk of stream) {
        if (this.aborted) {
          break;
        }
        if (typeof chunk === "string") {
          await consumeText(decoder.decode());
          await consumeText(chunk);
        } else {
          await consumeText(decoder.decode(chunk as Uint8Array, { stream: true }));
        }
      }
      await consumeText(decoder.decode());
    } finally {
      if (this.streamRelease) {
        const release = this.streamRelease;
        this.streamRelease = null;
        await release();
      }
      this.streamController = null;
      if (!this.aborted && this.autoReconnect) {
        this.isConnected = false;
        this.logger.log?.("[SSE] Stream ended, attempting reconnection...");
        await this.attemptReconnect();
      }
    }
  }

  async processEvent(eventData: string): Promise<void> {
    const lines = eventData.split("\n");
    let data: string | null = null;
    let eventId: number | null = null;

    for (const line of lines) {
      if (line.startsWith("id: ")) {
        eventId = parseUrbitSseEventId(line.slice(4));
      }
      if (line.startsWith("data: ")) {
        data = line.slice(6);
      }
    }

    if (!data) {
      return;
    }

    let parsed: ReturnType<typeof parseUrbitSsePayload>;
    try {
      parsed = parseUrbitSsePayload(data);
    } catch (error) {
      // Malformed transport payloads are permanent. Count them handled so one
      // poison event cannot pin the Urbit channel forever.
      this.logger.error?.(`Error parsing SSE event: ${String(error)}`);
      await this.acknowledgeHandledEventIfNeeded(eventId);
      return;
    }

    if (parsed.response === "quit") {
      if (parsed.id) {
        const handlers = this.eventHandlers.get(parsed.id);
        if (handlers?.quit) {
          handlers.quit();
        }
      }
    } else if (parsed.id && this.eventHandlers.has(parsed.id)) {
      const { event } = this.eventHandlers.get(parsed.id) ?? {};
      if (event && parsed.json) {
        await event(parsed.json);
      }
    } else if (parsed.json) {
      for (const { event } of this.eventHandlers.values()) {
        if (event) {
          await event(parsed.json);
        }
      }
    }
    // Handler failures propagate without ack. Durable callbacks resolve only after append.
    await this.acknowledgeHandledEventIfNeeded(eventId);
  }

  private async acknowledgeHandledEventIfNeeded(eventId: number | null): Promise<void> {
    if (eventId === null || eventId <= this.lastAcknowledgedEventId) {
      return;
    }
    this.lastHeardEventId = Math.max(this.lastHeardEventId, eventId);
    if (this.lastHeardEventId - this.lastAcknowledgedEventId <= this.ackThreshold) {
      return;
    }
    this.logger.log?.(
      `[SSE] Acking event ${this.lastHeardEventId} (last acked: ${this.lastAcknowledgedEventId})`,
    );
    // The acknowledged watermark advances only after PUT succeeds. A replay
    // therefore retries a failed ack instead of leaving the subscription clogged.
    await this.ack(this.lastHeardEventId);
  }

  async poke(params: { app: string; mark: string; json: unknown }) {
    return await pokeUrbitChannel(this.channelRequestContext(), {
      ...params,
      auditContext: "tlon-urbit-poke",
    });
  }

  async scry(path: string) {
    return await scryUrbitPath(
      {
        baseUrl: this.url,
        cookie: this.cookie,
        ssrfPolicy: this.ssrfPolicy,
        lookupFn: this.lookupFn,
        fetchImpl: this.fetchImpl,
      },
      { path, auditContext: "tlon-urbit-scry" },
    );
  }

  /**
   * Update the cookie used for authentication.
   * Call this when re-authenticating after session expiry.
   */
  updateCookie(newCookie: string): void {
    this.cookie = normalizeUrbitCookie(newCookie);
  }

  private async ack(eventId: number): Promise<void> {
    const ackData = {
      id: Date.now(),
      action: "ack",
      "event-id": eventId,
    };

    const { response, release } = await this.putChannelPayload([ackData], {
      timeoutMs: 10_000,
      auditContext: "tlon-urbit-ack",
    });

    try {
      if (!response.ok) {
        throw new Error(`Ack failed with status ${response.status}`);
      }
      this.lastAcknowledgedEventId = eventId;
    } finally {
      await release();
    }
  }

  async attemptReconnect() {
    if (this.aborted || !this.autoReconnect) {
      this.logger.log?.("[SSE] Reconnection aborted or disabled");
      return;
    }

    // If we've hit max attempts, wait longer then reset and keep trying
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.log?.(
        `[SSE] Max reconnection attempts (${this.maxReconnectAttempts}) reached. Waiting 10s before resetting...`,
      );
      // Wait 10 seconds before resetting and trying again
      const extendedBackoff = 10000; // 10 seconds
      await new Promise((resolve) => {
        setTimeout(resolve, extendedBackoff);
      });
      this.reconnectAttempts = 0; // Reset counter to continue trying
      this.logger.log?.("[SSE] Reconnection attempts reset, resuming reconnection...");
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.reconnectDelay * 2 ** (this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    );

    this.logger.log?.(
      `[SSE] Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`,
    );

    await new Promise((resolve) => {
      setTimeout(resolve, delay);
    });

    if (this.aborted || !this.autoReconnect) {
      return;
    }

    try {
      if (this.onReconnect) {
        await this.onReconnect(this);
      }

      try {
        // Reopen the same Eyre channel. Its queue retains every unacked event;
        // switching ids here would discard the cursor and strand failed admission.
        await this.openStream();
      } catch (error) {
        if (!(error instanceof UrbitHttpError) || error.status !== 404) {
          throw error;
        }
        // Eyre deletes idle channels. Only a definitive missing-channel response
        // permits losing the old cursor and rebuilding every subscription.
        this.resetChannelIdentity();
        await this.createCurrentChannel();
        await this.openStream();
      }
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.logger.log?.("[SSE] Reconnection successful!");
    } catch (error) {
      this.logger.error?.(`[SSE] Reconnection failed: ${String(error)}`);
      await this.attemptReconnect();
    }
  }

  stopReceiving(): void {
    this.aborted = true;
    this.isConnected = false;
    this.streamController?.abort();
  }

  async close() {
    this.stopReceiving();

    try {
      const unsubscribes = this.subscriptions.map((sub) => ({
        id: sub.id,
        action: "unsubscribe",
        subscription: sub.id,
      }));

      {
        const { response, release } = await this.putChannelPayload(unsubscribes, {
          timeoutMs: 30_000,
          auditContext: "tlon-urbit-unsubscribe",
        });
        try {
          void response.body?.cancel().catch(() => undefined);
        } finally {
          await release();
        }
      }

      {
        const { response, release } = await urbitFetch({
          baseUrl: this.url,
          path: `/~/channel/${this.channelId}`,
          init: {
            method: "DELETE",
            headers: {
              Cookie: this.cookie,
            },
          },
          ssrfPolicy: this.ssrfPolicy,
          lookupFn: this.lookupFn,
          fetchImpl: this.fetchImpl,
          timeoutMs: 30_000,
          auditContext: "tlon-urbit-channel-close",
        });
        try {
          void response.body?.cancel().catch(() => undefined);
        } finally {
          await release();
        }
      }
    } catch (error) {
      this.logger.error?.(`Error closing channel: ${String(error)}`);
    }

    if (this.streamRelease) {
      const release = this.streamRelease;
      this.streamRelease = null;
      await release();
    }
  }

  private async putChannelPayload(
    payload: unknown,
    params: { timeoutMs: number; auditContext: string },
  ) {
    return await urbitFetch({
      baseUrl: this.url,
      path: `/~/channel/${this.channelId}`,
      init: {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: this.cookie,
        },
        body: JSON.stringify(payload),
      },
      ssrfPolicy: this.ssrfPolicy,
      lookupFn: this.lookupFn,
      fetchImpl: this.fetchImpl,
      timeoutMs: params.timeoutMs,
      auditContext: params.auditContext,
    });
  }
}
