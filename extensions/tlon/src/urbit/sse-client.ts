import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { ensureUrbitChannelOpen, pokeUrbitChannel, scryUrbitPath } from "./channel-ops.js";
import { getUrbitContext, normalizeUrbitCookie } from "./context.js";
import { urbitFetch } from "./fetch.js";

export type UrbitSseLogger = {
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
    { event?: (data: unknown) => void; err?: (error: unknown) => void; quit?: () => void }
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

  // Event ack tracking - must ack every ~50 events to keep channel healthy
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
    this.reconnectDelay = options.reconnectDelay ?? 1000;
    this.maxReconnectDelay = options.maxReconnectDelay ?? 30000;
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

  async subscribe(params: {
    app: string;
    path: string;
    event?: (data: unknown) => void;
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
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `Subscribe failed: ${response.status}${errorText ? ` - ${errorText}` : ""}`,
        );
      }
    } finally {
      await release();
    }
  }

  async connect() {
    await ensureUrbitChannelOpen(this.channelRequestContext(), {
      createBody: this.subscriptions,
      createAuditContext: "tlon-urbit-channel-create",
    });

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

    const { response, release } = await urbitFetch({
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

    this.streamRelease = release;

    // Clear timeout once connection established (headers received).
    clearTimeout(timeoutId);

    if (!response.ok) {
      await release();
      this.streamRelease = null;
      throw new Error(`Stream connection failed: ${response.status}`);
    }

    this.processStream(response.body).catch((error) => {
      if (!this.aborted) {
        this.logger.error?.(`Stream error: ${String(error)}`);
        for (const { err } of this.eventHandlers.values()) {
          if (err) {
            err(error);
          }
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
    let buffer = "";

    try {
      for await (const chunk of stream) {
        if (this.aborted) {
          break;
        }
        buffer += chunk.toString();
        let eventEnd;
        while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
          const eventData = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          this.processEvent(eventData);
        }
      }
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

  processEvent(eventData: string) {
    const lines = eventData.split("\n");
    let data: string | null = null;
    let eventId: number | null = null;

    for (const line of lines) {
      if (line.startsWith("id: ")) {
        eventId = Number.parseInt(line.slice(4), 10);
      }
      if (line.startsWith("data: ")) {
        data = line.slice(6);
      }
    }

    if (!data) {
      return;
    }

    // Track event ID and send ack if needed
    if (eventId !== null && !Number.isNaN(eventId)) {
      if (eventId > this.lastHeardEventId) {
        this.lastHeardEventId = eventId;
        if (eventId - this.lastAcknowledgedEventId > this.ackThreshold) {
          this.logger.log?.(
            `[SSE] Acking event ${eventId} (last acked: ${this.lastAcknowledgedEventId})`,
          );
          this.ack(eventId).catch((err) => {
            this.logger.error?.(`Failed to ack event ${eventId}: ${String(err)}`);
          });
        }
      }
    }

    try {
      const parsed = JSON.parse(data) as { id?: number; json?: unknown; response?: string };

      if (parsed.response === "quit") {
        if (parsed.id) {
          const handlers = this.eventHandlers.get(parsed.id);
          if (handlers?.quit) {
            handlers.quit();
          }
        }
        return;
      }

      if (parsed.id && this.eventHandlers.has(parsed.id)) {
        const { event } = this.eventHandlers.get(parsed.id) ?? {};
        if (event && parsed.json) {
          event(parsed.json);
        }
      } else if (parsed.json) {
        for (const { event } of this.eventHandlers.values()) {
          if (event) {
            event(parsed.json);
          }
        }
      }
    } catch (error) {
      this.logger.error?.(`Error parsing SSE event: ${String(error)}`);
    }
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
    this.lastAcknowledgedEventId = eventId;

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
      await new Promise((resolve) => setTimeout(resolve, extendedBackoff));
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

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      this.channelId = `${Math.floor(Date.now() / 1000)}-${randomUUID()}`;
      this.channelUrl = new URL(`/~/channel/${this.channelId}`, this.url).toString();

      if (this.onReconnect) {
        await this.onReconnect(this);
      }

      await this.connect();
      this.logger.log?.("[SSE] Reconnection successful!");
    } catch (error) {
      this.logger.error?.(`[SSE] Reconnection failed: ${String(error)}`);
      await this.attemptReconnect();
    }
  }

  async close() {
    this.aborted = true;
    this.isConnected = false;
    this.streamController?.abort();

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
          void response.body?.cancel();
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
          void response.body?.cancel();
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
