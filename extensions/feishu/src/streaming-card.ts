/**
 * Feishu Streaming Card - Card Kit streaming API for real-time text output
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { fetchWithSsrFGuard, type LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { FEISHU_HTTP_TIMEOUT_MS } from "./client-timeout.js";
import { getFeishuUserAgent } from "./client.js";
import { requestFeishuApi } from "./comment-shared.js";
import { readFeishuJsonResponse } from "./json-response.js";
import { resolveFeishuCardTemplate, type CardHeaderConfig } from "./send.js";
import { resolveStreamingCardSendMode } from "./streaming-card-send-mode.js";
import {
  clearStreamingTokenCache,
  getStreamingToken,
  registerStreamingAccount,
  resolveApiBase,
  resolveAllowedHostnames,
  type StreamingCredentials as Credentials,
  type StreamingDeps as FeishuStreamingDeps,
  type StreamingFetch as FeishuStreamingFetch,
} from "./streaming-token-cache.js";
type CardState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  sentText: string;
  hasNote: boolean;
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

function cancelUnreadResponseBody(response: Response): void {
  // A rejected response leaves its body unread; start cancellation before the
  // guarded dispatcher is released so the connection is not leaked. Do not
  // await: debug capture can tee the stream and deadlock a waiter.
  if (!response.bodyUsed) {
    void response.body?.cancel().catch(() => undefined);
  }
}

async function assertSuccessfulCardKitResponse(
  response: Response,
  auditContext: string,
  action: string,
): Promise<CardKitResponse> {
  if (!response.ok) {
    cancelUnreadResponseBody(response);
    throw new Error(`${action} failed with HTTP ${response.status}`);
  }
  const data = await readFeishuJsonResponse<CardKitResponse>(response, auditContext);
  if (data.code !== 0) {
    throw new Error(`${action} failed: ${data.msg ?? "unknown error"} (code=${String(data.code)})`);
  }
  return data;
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
  private getClient: () => Client;
  private creds: Credentials;
  private accountId?: string;
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
    getClient: () => Client,
    creds: Credentials,
    log?: (msg: string) => void,
    deps?: FeishuStreamingDeps,
    accountId?: string,
  ) {
    this.getClient = getClient;
    this.creds = creds;
    this.log = log;
    this.fetchImpl = deps?.fetchImpl;
    this.lookupFn = deps?.lookupFn;
    this.accountId = accountId;
    if (accountId) {
      registerStreamingAccount(accountId, creds);
    }
  }

  /** Execute a CardKit API request with one-shot token-invalid retry (#97287).
   *  All direct CardKit writes (create, update, replace, note, close) go
   *  through here so a revoked tenant token during an active stream
   *  triggers cache clearing and a single retry with fresh credentials. */
  private async cardKitRequest(
    path: string,
    init: RequestInit,
    auditContext: string,
    action: string,
  ): Promise<CardKitResponse> {
    const apiBase = resolveApiBase(this.creds.domain);
    const url = path.startsWith("http") ? path : `${apiBase}${path}`;
    let tokenRetried = false;
    for (;;) {
      const { response, release } = await fetchWithSsrFGuard({
        url,
        init: {
          ...init,
          headers: {
            Authorization: `Bearer ${await getStreamingToken(this.creds, {
              fetchImpl: this.fetchImpl,
              lookupFn: this.lookupFn,
            })}`,
            ...(init.headers as Record<string, string>),
          },
        },
        fetchImpl: this.fetchImpl,
        lookupFn: this.lookupFn,
        policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
        auditContext,
        timeoutMs: this.creds.httpTimeoutMs ?? FEISHU_HTTP_TIMEOUT_MS,
      });
      let data: CardKitResponse;
      try {
        data = await assertSuccessfulCardKitResponse(response, auditContext, action);
      } finally {
        await release();
      }
      // Token-invalid → clear cache and retry once (#97287)
      if ((data.code === 99991663 || data.code === 99991664) && !tokenRetried) {
        // oxlint-disable-next-line no-useless-assignment -- read on next loop iteration
        tokenRetried = true;
        clearStreamingTokenCache(this.accountId);
        continue;
      }
      return data;
    }
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: StreamingCardOptions & StreamingStartOptions,
  ): Promise<void> {
    if (this.state) {
      return;
    }

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

    // Create card entity (with token-invalid retry via cardKitRequest #97287)
    const createData = await this.cardKitRequest(
      "/cardkit/v1/cards",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": getFeishuUserAgent() },
        body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
      },
      "feishu.streaming-card.create",
      "Create card",
    );
    const createResult = createData as { code: number; msg: string; data?: { card_id: string } };
    if (createResult.code !== 0 || !createResult.data?.card_id) {
      throw new Error(`Create card failed: ${createResult.msg}`);
    }
    const cardId = createResult.data.card_id;
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
          this.getClient().im.message.reply({
            path: { message_id: sendOptions.replyToMessageId! },
            data: {
              msg_type: "interactive",
              content: cardContent,
              ...(sendOptions.replyInThread ? { reply_in_thread: true } : {}),
            },
          }),
        "Send card failed",
        { accountId: this.accountId },
      );
    } else if (sendMode === "root_create") {
      // root_id is undeclared in the SDK types but accepted at runtime
      sendRes = await requestFeishuApi(
        () =>
          this.getClient().im.message.create({
            params: { receive_id_type: receiveIdType },
            data: Object.assign(
              { receive_id: receiveId, msg_type: "interactive", content: cardContent },
              { root_id: sendOptions.rootId },
            ),
          }),
        "Send card failed",
        { accountId: this.accountId },
      );
    } else {
      sendRes = await requestFeishuApi(
        () =>
          this.getClient().im.message.create({
            params: { receive_id_type: receiveIdType },
            data: {
              receive_id: receiveId,
              msg_type: "interactive",
              content: cardContent,
            },
          }),
        "Send card failed",
        { accountId: this.accountId },
      );
    }
    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    this.state = {
      cardId,
      messageId: sendRes.data.message_id,
      sequence: 1,
      currentText: "",
      sentText: "",
      hasNote: Boolean(options?.note),
    };
    this.log?.(`Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`);
  }

  private async updateCardContent(
    text: string,
    onError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (!this.state) {
      return false;
    }
    this.state.sequence += 1;
    try {
      await this.cardKitRequest(
        `/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "User-Agent": getFeishuUserAgent() },
          body: JSON.stringify({
            content: text,
            sequence: this.state.sequence,
            uuid: `s_${this.state.cardId}_${this.state.sequence}`,
          }),
        },
        "feishu.streaming-card.update",
        "Update card content",
      );
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
    this.state.sequence += 1;
    try {
      await this.cardKitRequest(
        `/cardkit/v1/cards/${this.state.cardId}/elements/content`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "User-Agent": getFeishuUserAgent() },
          body: JSON.stringify({
            element: JSON.stringify({ tag: "markdown", content: text, element_id: "content" }),
            sequence: this.state.sequence,
            uuid: `r_${this.state.cardId}_${this.state.sequence}`,
          }),
        },
        "feishu.streaming-card.replace",
        "Replace card content",
      );
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
    this.state.sequence += 1;
    try {
      await this.cardKitRequest(
        `/cardkit/v1/cards/${this.state.cardId}/elements/note/content`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "User-Agent": getFeishuUserAgent() },
          body: JSON.stringify({
            content: `<font color='grey'>${note}</font>`,
            sequence: this.state.sequence,
            uuid: `n_${this.state.cardId}_${this.state.sequence}`,
          }),
        },
        "feishu.streaming-card.note-update",
        "Update card note",
      );
    } catch (e) {
      this.log?.(`Note update failed: ${String(e)}`);
    }
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
      await this.cardKitRequest(
        `/cardkit/v1/cards/${this.state.cardId}/settings`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": getFeishuUserAgent(),
          },
          body: JSON.stringify({
            settings: JSON.stringify({
              config: {
                streaming_mode: false,
                summary: { content: truncateSummary(acceptedText) },
              },
            }),
            sequence: this.state.sequence,
            uuid: `c_${this.state.cardId}_${this.state.sequence}`,
          }),
        },
        "feishu.streaming-card.close",
        "Close streaming card",
      );
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
      messageId: finalState.messageId,
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

  async close(finalText?: string, options?: { note?: string }): Promise<boolean> {
    try {
      return (await this.closeWithResult(finalText, options)).visibleReplySent;
    } catch (error: unknown) {
      if (error instanceof FeishuStreamingFinalizationError) {
        return error.result.visibleReplySent;
      }
      throw error;
    }
  }

  async discard(): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    this.closed = true;
    this.clearFlushTimer();
    await this.queue;

    const currentState = this.state;
    try {
      const response = await this.getClient().im.message.delete({
        path: { message_id: currentState.messageId },
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`Delete streaming card message failed: ${response.msg ?? response.code}`);
      }
      this.state = null;
      this.pendingText = null;
      this.log?.(`Discarded streaming card: cardId=${currentState.cardId}`);
    } catch (error) {
      this.log?.(`Discard failed: ${String(error)}`);
      this.closed = false;
      await this.close("");
    }
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }
}
