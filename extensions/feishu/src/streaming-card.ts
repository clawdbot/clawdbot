/**
 * Feishu Streaming Card - Card Kit streaming API for real-time text output
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import {
  asDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import { fetchWithSsrFGuard, type LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { FEISHU_HTTP_TIMEOUT_MS } from "./client-timeout.js";
import { getFeishuUserAgent, isInvalidTenantAccessTokenResponse } from "./client.js";
import { requestFeishuApi } from "./comment-shared.js";
import { readFeishuJsonResponse } from "./json-response.js";
import { resolveFeishuCardTemplate, type CardHeaderConfig } from "./send.js";
import { resolveStreamingCardSendMode } from "./streaming-card-send-mode.js";
import type { FeishuDomain } from "./types.js";

type Credentials = {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
  httpTimeoutMs?: number;
};
type CardState = {
  cardId: string;
  messageId?: string;
  sequence: number;
  currentText: string;
  sentText: string;
  hasNote: boolean;
};

type FeishuStreamingFetch = typeof fetch;

type FeishuStreamingDeps = {
  /** Override fetch for tests while preserving the real SSRF guard path. */
  fetchImpl?: FeishuStreamingFetch;
  /** Override hostname lookup for hermetic SSRF-guard tests. */
  lookupFn?: LookupFn;
};

type CardKitResponse = { code?: number; msg?: string };

type FeishuStreamingCloseResult = {
  visibleReplySent: boolean;
  content?: string;
  messageId?: string;
};

/** Provider finalization failed after a streaming card may already be visible. */
export class FeishuStreamingFinalizationError extends Error {
  readonly result: FeishuStreamingCloseResult;

  constructor(cause: unknown, result: FeishuStreamingCloseResult) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "FeishuStreamingFinalizationError";
    this.result = result;
  }
}

/** Options for customising the initial streaming card appearance. */
type StreamingCardOptions = {
  /** Optional header with title and color template. */
  header?: CardHeaderConfig;
  /** Optional grey note footer text. */
  note?: string;
};

/** Optional header for streaming cards (title bar with color template) */
type StreamingCardHeader = {
  title: string;
  /** Color template: blue, green, red, orange, purple, indigo, wathet, turquoise, yellow, grey, carmine, violet, lime */
  template?: string;
};

type StreamingStartOptions = {
  replyToMessageId?: string;
  replyInThread?: boolean;
  rootId?: string;
  header?: StreamingCardHeader;
};

const STREAMING_UPDATE_THROTTLE_MS = 160;
const STREAMING_SIGNIFICANT_DELTA_CHARS = 18;
const FEISHU_STREAMING_TOKEN_DEFAULT_LIFETIME_SECONDS = 7200;

type TokenState = {
  token?: string;
  expiresAt?: number;
  pending?: Promise<string>;
};

// Client identity fences token state across credential and domain generations.
const tokenStates = new WeakMap<Client, TokenState>();

function resolveStreamingTokenExpiresAt(value: unknown, nowMs = Date.now()): number {
  const now = resolveDateTimestampMs(nowMs);
  if (typeof value === "number" && Number.isFinite(value) && value <= 0) {
    return now;
  }
  return (
    resolveExpiresAtMsFromDurationSeconds(value, { nowMs: now }) ??
    resolveExpiresAtMsFromDurationSeconds(FEISHU_STREAMING_TOKEN_DEFAULT_LIFETIME_SECONDS, {
      nowMs: now,
    }) ??
    now
  );
}

function resolveApiBase(domain?: FeishuDomain): string {
  if (domain === "lark") {
    return "https://open.larksuite.com/open-apis";
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}

function resolveAllowedHostnames(domain?: FeishuDomain): string[] {
  if (domain === "lark") {
    return ["open.larksuite.com"];
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    try {
      return [new URL(domain).hostname];
    } catch {
      return [];
    }
  }
  return ["open.feishu.cn"];
}

function cancelUnreadResponseBody(response: Response): void {
  // A rejected response leaves its body unread; start cancellation before the
  // guarded dispatcher is released so the connection is not leaked. Do not
  // await: debug capture can tee the stream and deadlock a waiter.
  if (!response.bodyUsed) {
    void response.body?.cancel().catch(() => undefined);
  }
}

function getTokenState(client: Client): TokenState {
  const existing = tokenStates.get(client);
  if (existing) {
    return existing;
  }
  const state: TokenState = {};
  tokenStates.set(client, state);
  return state;
}

async function acquireToken(
  client: Client,
  creds: Credentials,
  deps?: FeishuStreamingDeps,
): Promise<string> {
  const state = getTokenState(client);
  const rawNow = Date.now();
  const hasValidClock = asDateTimestampMs(rawNow) !== undefined;
  const now = resolveDateTimestampMs(rawNow);
  const minUsableExpiresAt = resolveExpiresAtMsFromDurationSeconds(60, { nowMs: now }) ?? now;
  if (
    state.token &&
    state.expiresAt !== undefined &&
    hasValidClock &&
    state.expiresAt > minUsableExpiresAt
  ) {
    return state.token;
  }
  if (state.pending) {
    return state.pending;
  }

  const pending = (async () => {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": getFeishuUserAgent() },
        body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
      },
      fetchImpl: deps?.fetchImpl,
      lookupFn: deps?.lookupFn,
      policy: { allowedHostnames: resolveAllowedHostnames(creds.domain) },
      auditContext: "feishu.streaming-card.token",
      timeoutMs: creds.httpTimeoutMs ?? FEISHU_HTTP_TIMEOUT_MS,
    });
    let data: {
      code: number;
      msg: string;
      tenant_access_token?: string;
      expire?: number;
    };
    try {
      if (!response.ok) {
        cancelUnreadResponseBody(response);
        throw new Error(`Token request failed with HTTP ${response.status}`);
      }
      data = await readFeishuJsonResponse(response, "feishu.streaming-card.token");
    } finally {
      await release();
    }
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`Token error: ${data.msg}`);
    }
    state.token = data.tenant_access_token;
    state.expiresAt = resolveStreamingTokenExpiresAt(data.expire, now);
    return data.tenant_access_token;
  })();
  state.pending = pending;
  try {
    return await pending;
  } finally {
    if (state.pending === pending) {
      state.pending = undefined;
    }
  }
}

async function recoverToken(
  client: Client,
  creds: Credentials,
  deps: FeishuStreamingDeps | undefined,
  failedToken: string,
): Promise<string> {
  const state = getTokenState(client);
  if (state.token && state.token !== failedToken) {
    return state.token;
  }
  if (state.pending) {
    return state.pending;
  }
  state.token = undefined;
  state.expiresAt = undefined;
  return acquireToken(client, creds, deps);
}

async function requestCardKit<T extends CardKitResponse>(params: {
  client: Client;
  creds: Credentials;
  deps?: FeishuStreamingDeps;
  url: string;
  method: "POST" | "PUT" | "PATCH";
  body: Record<string, unknown>;
  auditContext: string;
  httpAction: string;
  apiAction: string;
  contentType?: string;
}): Promise<T> {
  let token = await acquireToken(params.client, params.creds, params.deps);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { response, release } = await fetchWithSsrFGuard({
      url: params.url,
      init: {
        method: params.method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": params.contentType ?? "application/json",
          "User-Agent": getFeishuUserAgent(),
        },
        body: JSON.stringify(params.body),
      },
      fetchImpl: params.deps?.fetchImpl,
      lookupFn: params.deps?.lookupFn,
      policy: { allowedHostnames: resolveAllowedHostnames(params.creds.domain) },
      auditContext: params.auditContext,
      timeoutMs: params.creds.httpTimeoutMs ?? FEISHU_HTTP_TIMEOUT_MS,
    });
    let data: T;
    try {
      try {
        data = await readFeishuJsonResponse<T>(response, params.auditContext);
      } catch (error) {
        if (!response.ok) {
          throw new Error(`${params.httpAction} failed with HTTP ${response.status}`, {
            cause: error,
          });
        }
        throw error;
      }
    } finally {
      await release();
    }
    if (attempt === 0 && isInvalidTenantAccessTokenResponse(data)) {
      token = await recoverToken(params.client, params.creds, params.deps, token);
      continue;
    }
    if (!response.ok) {
      throw new Error(`${params.httpAction} failed with HTTP ${response.status}`);
    }
    if (data.code !== 0) {
      throw new Error(
        `${params.apiAction} failed: ${data.msg ?? "unknown error"} (code=${String(data.code)})`,
      );
    }
    return data;
  }
  throw new Error(`${params.apiAction} failed after tenant token recovery`);
}

function truncateSummary(text: string, max = 50): string {
  if (!text) {
    return "";
  }
  const clean = text.replace(/\n/g, " ").trim();
  // Slice on a code-point boundary so CardKit never receives a lone surrogate at the limit.
  return clean.length <= max ? clean : sliceUtf16Safe(clean, 0, max - 3) + "...";
}

function shouldPushStreamingUpdate(previousText: string, nextText: string): boolean {
  return (
    !previousText ||
    /[\n。！？!?；;：:]$/.test(nextText) ||
    nextText.length - previousText.length >= STREAMING_SIGNIFICANT_DELTA_CHARS
  );
}

/** Merges cumulative or overlapping streaming snapshots without duplicating content. */
export function mergeStreamingText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) {
    return previous;
  }
  if (!previous || next === previous) {
    return next;
  }
  if (next.startsWith(previous) || next.includes(previous)) {
    return next;
  }
  if (previous.startsWith(next) || previous.includes(next)) {
    return previous;
  }
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  return `${previous}${next}`;
}

/** Streaming card session manager */
export class FeishuStreamingSession {
  private client: Client;
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log?: (msg: string) => void;
  private lastUpdateTime = 0;
  private pendingText: string | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private updateThrottleMs = STREAMING_UPDATE_THROTTLE_MS;
  private fetchImpl?: FeishuStreamingFetch;
  private lookupFn?: LookupFn;

  constructor(
    client: Client,
    creds: Credentials,
    log?: (msg: string) => void,
    deps?: FeishuStreamingDeps,
  ) {
    this.client = client;
    this.creds = creds;
    this.log = log;
    this.fetchImpl = deps?.fetchImpl;
    this.lookupFn = deps?.lookupFn;
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: StreamingCardOptions & StreamingStartOptions,
  ): Promise<void> {
    if (this.state) {
      return;
    }

    const apiBase = resolveApiBase(this.creds.domain);
    const elements: Record<string, unknown>[] = [
      { tag: "markdown", content: "", element_id: "content" },
    ];
    if (options?.note) {
      elements.push({ tag: "hr" });
      elements.push({
        tag: "markdown",
        content: `<font color='grey'>${options.note}</font>`,
        element_id: "note",
      });
    }
    const cardJson: Record<string, unknown> = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 1 } },
      },
      body: { elements },
    };
    if (options?.header) {
      cardJson.header = {
        title: { tag: "plain_text", content: options.header.title },
        template: resolveFeishuCardTemplate(options.header.template) ?? "blue",
      };
    }

    // Create card entity
    const createData = await requestCardKit<{
      code: number;
      msg: string;
      data?: { card_id: string };
    }>({
      client: this.client,
      creds: this.creds,
      deps: { fetchImpl: this.fetchImpl, lookupFn: this.lookupFn },
      url: `${apiBase}/cardkit/v1/cards`,
      method: "POST",
      body: { type: "card_json", data: JSON.stringify(cardJson) },
      auditContext: "feishu.streaming-card.create",
      httpAction: "Create card request",
      apiAction: "Create card",
    });
    if (!createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }
    const cardId = createData.data.card_id;
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });

    // Prefer message.reply when we have a reply target — reply_in_thread
    // reliably routes streaming cards into Feishu topics, whereas
    // message.create with root_id may silently ignore root_id for card
    // references (card_id format).
    let sendRes;
    const sendOptions = options ?? {};
    const sendMode = resolveStreamingCardSendMode(sendOptions);
    if (sendMode === "reply") {
      sendRes = await requestFeishuApi(
        () =>
          this.client.im.message.reply({
            path: { message_id: sendOptions.replyToMessageId! },
            data: {
              msg_type: "interactive",
              content: cardContent,
              ...(sendOptions.replyInThread ? { reply_in_thread: true } : {}),
            },
          }),
        "Send card failed",
      );
    } else {
      sendRes = await requestFeishuApi(
        () =>
          this.client.im.message.create({
            params: { receive_id_type: receiveIdType },
            data: {
              receive_id: receiveId,
              msg_type: "interactive",
              content: cardContent,
              // The SDK omits root_id from its types, but Feishu accepts it at runtime.
              ...(sendMode === "root_create" ? { root_id: sendOptions.rootId } : {}),
            },
          }),
        "Send card failed",
      );
    }
    if (sendRes.code !== 0) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    const messageId = sendRes.data?.message_id?.trim();
    this.state = {
      cardId,
      ...(messageId ? { messageId } : {}),
      sequence: 1,
      currentText: "",
      sentText: "",
      hasNote: Boolean(options?.note),
    };
    this.log?.(`Started streaming: cardId=${cardId}${messageId ? `, messageId=${messageId}` : ""}`);
  }

  private async updateCardContent(
    text: string,
    onError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (!this.state) {
      return false;
    }
    const apiBase = resolveApiBase(this.creds.domain);
    this.state.sequence += 1;
    try {
      await requestCardKit({
        client: this.client,
        creds: this.creds,
        deps: { fetchImpl: this.fetchImpl, lookupFn: this.lookupFn },
        url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
        method: "PUT",
        body: {
          content: text,
          sequence: this.state.sequence,
          uuid: `s_${this.state.cardId}_${this.state.sequence}`,
        },
        auditContext: "feishu.streaming-card.update",
        httpAction: "Update card content",
        apiAction: "Update card content",
      });
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    }
  }

  private async replaceCardContent(
    text: string,
    onError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (!this.state) {
      return false;
    }
    const apiBase = resolveApiBase(this.creds.domain);
    this.state.sequence += 1;
    try {
      await requestCardKit({
        client: this.client,
        creds: this.creds,
        deps: { fetchImpl: this.fetchImpl, lookupFn: this.lookupFn },
        url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/content`,
        method: "PUT",
        body: {
          element: JSON.stringify({ tag: "markdown", content: text, element_id: "content" }),
          sequence: this.state.sequence,
          uuid: `r_${this.state.cardId}_${this.state.sequence}`,
        },
        auditContext: "feishu.streaming-card.replace",
        httpAction: "Replace card content",
        apiAction: "Replace card content",
      });
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private schedulePendingFlush(): void {
    if (this.flushTimer || !this.pendingText || this.closed) {
      return;
    }
    const delayMs = Math.max(0, this.updateThrottleMs - (Date.now() - this.lastUpdateTime));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.pendingText || this.closed) {
        return;
      }
      this.lastUpdateTime = Date.now();
      void this.flushPendingUpdate().catch((error: unknown) =>
        this.log?.(`Scheduled flush update failed: ${String(error)}`),
      );
    }, delayMs);
  }

  private async flushPendingUpdate(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) {
        return;
      }
      const nextText = this.pendingText;
      if (!nextText) {
        return;
      }
      this.pendingText = null;
      if (nextText === this.state.sentText) {
        return;
      }
      const sent = await this.updateCardContent(nextText, (e) =>
        this.log?.(`Update failed: ${String(e)}`),
      );
      if (sent && this.state) {
        this.state.sentText = nextText;
      }
    });
    await this.queue;
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.closed || !text) {
      return;
    }
    // The caller supplies the complete current card text. CardKit derives its own
    // display delta, so merging snapshots here can duplicate divergent reasoning.
    this.state.currentText = text;
    this.pendingText = text;
    this.clearFlushTimer();

    const shouldForceUpdate = shouldPushStreamingUpdate(this.state.sentText, text);
    const now = Date.now();
    if (!shouldForceUpdate && now - this.lastUpdateTime < this.updateThrottleMs) {
      this.schedulePendingFlush();
      return;
    }
    this.lastUpdateTime = now;
    await this.flushPendingUpdate();
  }

  private async updateNoteContent(note: string): Promise<void> {
    if (!this.state || !this.state.hasNote) {
      return;
    }
    const apiBase = resolveApiBase(this.creds.domain);
    this.state.sequence += 1;
    await requestCardKit({
      client: this.client,
      creds: this.creds,
      deps: { fetchImpl: this.fetchImpl, lookupFn: this.lookupFn },
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/note/content`,
      method: "PUT",
      body: {
        content: `<font color='grey'>${note}</font>`,
        sequence: this.state.sequence,
        uuid: `n_${this.state.cardId}_${this.state.sequence}`,
      },
      auditContext: "feishu.streaming-card.note-update",
      httpAction: "Update card note",
      apiAction: "Update card note",
    }).catch((e: unknown) => this.log?.(`Note update failed: ${String(e)}`));
  }

  async closeWithResult(
    finalText?: string,
    options?: { note?: string },
  ): Promise<FeishuStreamingCloseResult> {
    if (!this.state || this.closed) {
      return { visibleReplySent: false };
    }
    this.closed = true;
    this.clearFlushTimer();
    await this.queue;

    const text = finalText ?? this.pendingText ?? this.state.currentText;
    const apiBase = resolveApiBase(this.creds.domain);
    // A failed final rewrite does not erase previously accepted visible content.
    // sentText advances only for an accepted write; the return value reports any visible content.
    let visibleContentSent = Boolean(this.state.sentText.trim());
    let finalWriteError: unknown;

    // Only send final update if content differs from what's already displayed.
    // An explicit empty final text clears a transient preview before closeout.
    if ((text || finalText !== undefined) && text !== this.state.sentText) {
      const sent = text.startsWith(this.state.sentText)
        ? await this.updateCardContent(text, (e) => {
            finalWriteError = e;
            this.log?.(`Final update failed: ${String(e)}`);
          })
        : await this.replaceCardContent(text, (e) => {
            finalWriteError = e;
            this.log?.(`Final replace failed: ${String(e)}`);
          });
      this.state.currentText = text;
      if (sent) {
        this.state.sentText = text;
        visibleContentSent = Boolean(text.trim());
      }
    }

    // Update note with final model/provider info
    if (options?.note) {
      await this.updateNoteContent(options.note);
    }

    // Close streaming mode
    // A rejected final write must not advertise content that CardKit never accepted.
    const acceptedText = this.state.sentText;
    this.state.sequence += 1;
    let closeError: unknown;
    try {
      await requestCardKit({
        client: this.client,
        creds: this.creds,
        deps: { fetchImpl: this.fetchImpl, lookupFn: this.lookupFn },
        url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`,
        method: "PATCH",
        body: {
          settings: JSON.stringify({
            config: {
              streaming_mode: false,
              summary: { content: truncateSummary(acceptedText) },
            },
          }),
          sequence: this.state.sequence,
          uuid: `c_${this.state.cardId}_${this.state.sequence}`,
        },
        auditContext: "feishu.streaming-card.close",
        httpAction: "Close streaming card",
        apiAction: "Close streaming card",
        contentType: "application/json; charset=utf-8",
      });
    } catch (error: unknown) {
      closeError = error;
      this.log?.(`Close failed: ${String(error)}`);
    }
    const finalState = this.state;
    this.state = null;
    this.pendingText = null;

    this.log?.(`Closed streaming: cardId=${finalState.cardId}`);
    const result: FeishuStreamingCloseResult = {
      visibleReplySent: visibleContentSent,
      ...(visibleContentSent ? { content: finalState.sentText } : {}),
      ...(finalState.messageId ? { messageId: finalState.messageId } : {}),
    };
    if (finalWriteError !== undefined || closeError !== undefined) {
      const cause =
        finalWriteError !== undefined && closeError !== undefined
          ? new AggregateError(
              [finalWriteError, closeError],
              "Feishu streaming card finalization failed",
            )
          : (finalWriteError ?? closeError);
      throw new FeishuStreamingFinalizationError(cause, result);
    }
    return result;
  }

  async discard(): Promise<FeishuStreamingCloseResult> {
    if (!this.state || this.closed) {
      return { visibleReplySent: false };
    }
    const { cardId, messageId } = this.state;
    if (!messageId) {
      // Accepted cards without a message receipt can still be cleared by card id.
      return this.closeWithResult("");
    }
    this.closed = true;
    this.clearFlushTimer();
    await this.queue;

    try {
      const response = await this.client.im.message.delete({
        path: { message_id: messageId },
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`Delete streaming card message failed: ${response.msg ?? response.code}`);
      }
      this.state = null;
      this.pendingText = null;
      this.log?.(`Discarded streaming card: cardId=${cardId}`);
      return { visibleReplySent: false };
    } catch (error) {
      this.log?.(`Discard failed: ${String(error)}`);
      this.closed = false;
      // A rejected clear leaves accepted text visible; preserve its receipt and failure.
      return this.closeWithResult("");
    }
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }
}
