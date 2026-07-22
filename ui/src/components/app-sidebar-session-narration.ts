import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  stripInternalRuntimeContext,
} from "../../../src/agents/internal-runtime-context.js";
import {
  isSuppressedControlReplyLeadFragment,
  isSuppressedControlReplyText,
  stripSuppressedControlReplyToken,
} from "../../../src/gateway/control-reply-text.js";
import { stripInlineDirectiveTagsForDisplay } from "../../../src/utils/directive-tags.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { stripHeartbeatTokenForDisplay } from "../lib/chat/heartbeat-display.ts";
import { extractText } from "../lib/chat/message-extract.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
} from "../lib/sessions/session-key.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { deriveSidebarNarrationLine } from "./sidebar-narration-line.ts";

const SIDEBAR_NARRATION_SUBSCRIPTION_LIMIT = 6;
const SIDEBAR_NARRATION_THROTTLE_MS = 2_000;
const SIDEBAR_NARRATION_BUFFER_CHARS = 16_384;

type SessionMessageSubscription = Awaited<ReturnType<SessionCapability["subscribeMessages"]>>;

type NarrationSubscription = {
  source: SessionCapability;
  subscription: SessionMessageSubscription;
};

type PendingSubscription = {
  agentId: string | null;
  connectionIdentity: object;
  source: SessionCapability;
  operationId: symbol;
};

type NarrationActivity = { kind: "text"; text: string } | { kind: "line"; line: string };

type ThrottledLine = {
  lastPublishedAt: number;
  pending: NarrationActivity | null;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
};

export type SidebarNarrationSyncInput = {
  enabled: boolean;
  connected: boolean;
  connectionIdentity: object | null;
  source: SessionCapability | null;
  rows: readonly SidebarRecentSession[];
  openSessionKey: string;
  agentId: string;
};

function normalizeSidebarNarrationText(text: string): string | null {
  const displayText = stripSuppressedControlReplyToken(
    stripInternalRuntimeContext(stripInlineDirectiveTagsForDisplay(text).text),
  );
  const heartbeat = stripHeartbeatTokenForDisplay(displayText);
  if (
    !displayText ||
    isSuppressedControlReplyText(displayText) ||
    isSuppressedControlReplyLeadFragment(displayText) ||
    heartbeat.shouldSkip
  ) {
    return null;
  }
  return heartbeat.text;
}

function trailingInternalDelimiterPrefix(text: string): string {
  const tokens = [INTERNAL_RUNTIME_CONTEXT_BEGIN, INTERNAL_RUNTIME_CONTEXT_END];
  for (
    let length = Math.min(text.length, ...tokens.map((token) => token.length - 1));
    length >= 1;
    length -= 1
  ) {
    const suffix = text.slice(-length);
    if (tokens.some((token) => token.startsWith(suffix))) {
      return suffix;
    }
  }
  return "";
}

function rowIsRunning(row: SidebarRecentSession): boolean {
  return row.hasActiveRun || row.status === "running";
}

function rowRecency(row: SidebarRecentSession): number {
  return row.startedAt ?? row.updatedAt ?? 0;
}

function eventAgentMatches(targetAgentId: string, payloadAgentId: unknown): boolean {
  return (
    typeof payloadAgentId !== "string" ||
    !payloadAgentId.trim() ||
    normalizeAgentId(payloadAgentId) === normalizeAgentId(targetAgentId)
  );
}

/** Owns the bounded session subscriptions and per-row activity throttles. */
export class SidebarSessionNarrationController {
  private source: SessionCapability | null = null;
  private connectionIdentity: object | null = null;
  private connected = false;
  private enabled = false;
  private openSessionKey = "";
  private agentId = "main";
  private desiredKeys = new Set<string>();
  private subscriptions = new Map<string, NarrationSubscription>();
  private pendingSubscriptions = new Map<string, PendingSubscription>();
  private deferredSubscriptions = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
  private internalRuntimeBlockDepth = new Map<string, number>();
  private internalRuntimeDelimiterTails = new Map<string, string>();
  // Chars of the FULL cumulative assistant stream consumed so far, per session.
  // Length arithmetic (not stored text) keeps append detection O(delta) even
  // after the visible buffer trims; storing the raw stream made long responses
  // fail prefix checks post-trim and reparse the whole snapshot per delta.
  private consumedStreamLength = new Map<string, number>();
  private visibleText = new Map<string, string>();
  private runIds = new Map<string, string>();
  private throttles = new Map<string, ThrottledLine>();
  private lines = new Map<string, string>();
  private observerDigests = new Map<string, SessionObserverDigest>();

  constructor(
    private readonly onLinesChanged: (lines: ReadonlyMap<string, string>) => void,
    private readonly onObserverDigestsChanged: (
      digests: ReadonlyMap<string, SessionObserverDigest>,
    ) => void = () => undefined,
  ) {}

  sync(input: SidebarNarrationSyncInput): void {
    const previousOpenSessionKey = this.openSessionKey;
    const connectionChanged = this.connectionIdentity !== input.connectionIdentity;
    const sourceChanged = this.source !== input.source;
    const disconnected = !input.connected || !input.connectionIdentity || !input.source;
    if (connectionChanged || sourceChanged || disconnected) {
      // A replaced or closed socket already discarded its server-side set.
      // Never send cleanup through a new connection for ownership from the old one.
      this.resetSubscriptions({ unsubscribe: !connectionChanged && this.connected });
    }

    this.source = input.source;
    this.connectionIdentity = input.connectionIdentity;
    this.connected = input.connected;
    this.enabled = input.enabled;
    this.openSessionKey = input.openSessionKey.trim();
    this.agentId = normalizeAgentId(input.agentId);

    if (disconnected || !input.enabled) {
      this.desiredKeys = new Set();
      this.resetSubscriptions({ unsubscribe: !disconnected });
      this.clearAllLines();
      return;
    }

    const candidates = input.rows
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row }) => rowIsRunning(row) && !areUiSessionKeysEquivalent(row.key, this.openSessionKey),
      )
      .toSorted(
        (left, right) => rowRecency(right.row) - rowRecency(left.row) || left.index - right.index,
      )
      .slice(0, SIDEBAR_NARRATION_SUBSCRIPTION_LIMIT);
    const nextDesired = new Set(candidates.map(({ row }) => row.key));

    for (const key of this.desiredKeys) {
      if (nextDesired.has(key)) {
        continue;
      }
      // The chat pane and sidebar share a per-connection Set, not a refcount.
      // Hand an opening row to chat without deleting the subscription it now owns.
      const ownedAgentId =
        this.subscriptions.get(key)?.subscription.agentId ??
        this.pendingSubscriptions.get(key)?.agentId ??
        null;
      const handedToChat = this.subscriptionScopeMatchesOpenChat(key, ownedAgentId);
      this.releaseKey(key, { unsubscribe: !handedToChat });
    }

    this.desiredKeys = nextDesired;
    for (const key of nextDesired) {
      const targetAgentId = this.subscriptionAgentId(key);
      const ownedAgentId = this.subscriptions.get(key)?.subscription.agentId ?? null;
      const pendingAgentId = this.pendingSubscriptions.get(key)?.agentId ?? null;
      if (
        (this.subscriptions.has(key) && ownedAgentId !== targetAgentId) ||
        (this.pendingSubscriptions.has(key) && pendingAgentId !== targetAgentId)
      ) {
        this.releaseKey(key, { unsubscribe: true });
      }
      if (this.subscriptions.has(key) || this.pendingSubscriptions.has(key)) {
        continue;
      }
      const chatJustReleased = areUiSessionKeysEquivalent(key, previousOpenSessionKey);
      this.scheduleSubscription(key, chatJustReleased);
    }
  }

  handleEvent(event: GatewayEventFrame): void {
    if (!this.enabled || !this.connected) {
      return;
    }
    if (event.event === "chat") {
      this.handleChatEvent(event.payload);
      return;
    }
    if (event.event === "session.observer") {
      this.handleObserverEvent(event.payload);
      return;
    }
    if (event.event === "agent" || event.event === "session.tool") {
      this.handleAgentEvent(event.payload);
    }
  }

  disconnect(): void {
    this.desiredKeys = new Set();
    this.resetSubscriptions({ unsubscribe: this.connected });
    this.clearAllLines();
    this.connected = false;
  }

  private scheduleSubscription(key: string, defer: boolean): void {
    if (!defer) {
      void this.subscribeKey(key);
      return;
    }
    if (this.deferredSubscriptions.has(key)) {
      return;
    }
    // Chat unsubscribes during the same Lit update. Queueing this request makes
    // the wire order unsubscribe -> subscribe when a running row leaves chat.
    const timer = globalThis.setTimeout(() => {
      this.deferredSubscriptions.delete(key);
      void this.subscribeKey(key);
    }, 0);
    this.deferredSubscriptions.set(key, timer);
  }

  private async subscribeKey(key: string): Promise<void> {
    const source = this.source;
    const connectionIdentity = this.connectionIdentity;
    if (
      !source ||
      !connectionIdentity ||
      !this.connected ||
      !this.enabled ||
      !this.desiredKeys.has(key)
    ) {
      return;
    }
    const operationId = Symbol(key);
    const agentId = this.subscriptionAgentId(key);
    this.pendingSubscriptions.set(key, { agentId, connectionIdentity, operationId, source });
    try {
      const subscription = await source.subscribeMessages(key, {
        agentId: agentId ?? undefined,
      });
      const pending = this.pendingSubscriptions.get(key);
      if (pending?.operationId !== operationId || pending.source !== source) {
        const completedAgentId = subscription.agentId ?? null;
        const replacementOwnsSameScope =
          this.desiredKeys.has(key) &&
          (this.subscriptions.get(key)?.subscription.agentId === completedAgentId ||
            this.pendingSubscriptions.get(key)?.agentId === completedAgentId ||
            (this.deferredSubscriptions.has(key) &&
              this.subscriptionAgentId(key) === completedAgentId));
        if (
          !replacementOwnsSameScope &&
          connectionIdentity === this.connectionIdentity &&
          !this.subscriptionScopeMatchesOpenChat(key, completedAgentId)
        ) {
          await source.unsubscribeMessages(subscription).catch(() => undefined);
        }
        return;
      }
      this.pendingSubscriptions.delete(key);
      if (
        source !== this.source ||
        connectionIdentity !== this.connectionIdentity ||
        !this.connected ||
        !this.enabled ||
        !this.desiredKeys.has(key)
      ) {
        if (!this.subscriptionScopeMatchesOpenChat(key, subscription.agentId ?? null)) {
          await source.unsubscribeMessages(subscription).catch(() => undefined);
        }
        return;
      }
      this.subscriptions.set(key, { source, subscription });
    } catch {
      const pending = this.pendingSubscriptions.get(key);
      if (pending?.operationId === operationId) {
        this.pendingSubscriptions.delete(key);
      }
    }
  }

  private subscriptionAgentId(key: string): string | null {
    return isUiGlobalSessionKey(key) ? this.agentId : null;
  }

  private subscriptionScopeMatchesOpenChat(key: string, agentId: string | null): boolean {
    if (!areUiSessionKeysEquivalent(key, this.openSessionKey)) {
      return false;
    }
    return !isUiGlobalSessionKey(key) || agentId === this.subscriptionAgentId(key);
  }

  private releaseKey(key: string, options: { unsubscribe: boolean }): void {
    const deferred = this.deferredSubscriptions.get(key);
    if (deferred) {
      globalThis.clearTimeout(deferred);
      this.deferredSubscriptions.delete(key);
    }
    this.pendingSubscriptions.delete(key);
    const owned = this.subscriptions.get(key);
    this.subscriptions.delete(key);
    if (owned && options.unsubscribe) {
      void owned.source.unsubscribeMessages(owned.subscription).catch(() => undefined);
    }
    this.clearLine(key);
  }

  private resetSubscriptions(options: { unsubscribe: boolean }): void {
    const keys = new Set([
      ...this.subscriptions.keys(),
      ...this.pendingSubscriptions.keys(),
      ...this.deferredSubscriptions.keys(),
    ]);
    for (const key of keys) {
      this.releaseKey(key, options);
    }
  }

  private matchingDesiredKey(sessionKey: unknown, payloadAgentId: unknown): string | null {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      return null;
    }
    for (const key of this.desiredKeys) {
      if (
        areUiSessionKeysEquivalent(key, sessionKey) &&
        (!isUiGlobalSessionKey(key) || eventAgentMatches(this.agentId, payloadAgentId))
      ) {
        return key;
      }
    }
    return null;
  }

  private handleChatEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const record = payload as Record<string, unknown>;
    const key = this.matchingDesiredKey(record.sessionKey, record.agentId);
    if (!key) {
      return;
    }
    this.observeRun(key, record.runId);
    if (this.observerDigests.has(key)) {
      return;
    }
    const message = record.message as Record<string, unknown> | undefined;
    if (message && typeof message.role === "string" && message.role !== "assistant") {
      return;
    }
    const deltaText = typeof record.deltaText === "string" ? record.deltaText : "";
    const messageText = message ? extractText(message) : null;
    const consumed = this.consumedStreamLength.get(key) ?? 0;
    // A newly subscribed sidebar can join mid-run. Within one run the server's
    // cumulative snapshot grows monotonically, so length arithmetic decides
    // append vs rejoin without storing the raw stream.
    if (record.replace === true) {
      // Handle before any truthiness gate: an EMPTY replacement retracts the
      // narration line (streamLength 0 takes publishText's clearing path).
      const replacement = deltaText || messageText || "";
      this.publishText(key, {
        streamLength: replacement.length,
        fragment: replacement,
        reset: true,
      });
      return;
    }
    if (deltaText) {
      if (messageText) {
        const appends = consumed > 0 && messageText.length - deltaText.length === consumed;
        if (appends) {
          this.publishText(key, {
            streamLength: messageText.length,
            fragment: deltaText,
            reset: false,
          });
        } else {
          this.publishText(key, {
            streamLength: messageText.length,
            fragment: messageText,
            reset: true,
          });
        }
      } else if (consumed > 0) {
        this.publishText(key, {
          streamLength: consumed + deltaText.length,
          fragment: deltaText,
          reset: false,
        });
      }
      // consumed === 0 with a bare delta: a mid-run join may sit INSIDE an
      // internal-context block whose opening delimiter we never saw. Stay
      // silent until a cumulative snapshot or replacement aligns the stream.
      return;
    }
    if (messageText) {
      this.publishText(key, {
        streamLength: messageText.length,
        fragment: messageText,
        reset: true,
      });
    }
  }

  private publishText(
    key: string,
    update: { streamLength: number; fragment: string; reset: boolean },
  ): void {
    if (update.streamLength <= 0) {
      if (update.reset) {
        // An empty replacement retracts prior content; a stale line must not
        // outlive it (the draft it showed may have been withdrawn).
        this.clearLine(key);
      }
      return;
    }
    this.consumedStreamLength.set(key, update.streamLength);
    if (update.reset) {
      this.internalRuntimeBlockDepth.delete(key);
      this.internalRuntimeDelimiterTails.delete(key);
      this.visibleText.delete(key);
      // A replacement supersedes anything still queued behind the throttle;
      // otherwise a pre-replacement draft could republish after retraction.
      const throttle = this.throttles.get(key);
      if (throttle) {
        throttle.pending = null;
      }
    }
    const visibleFragment = this.stripInternalRuntimeFragment(key, update.fragment);
    const previousVisibleText = update.reset ? "" : (this.visibleText.get(key) ?? "");
    const nextVisibleText = `${previousVisibleText}${visibleFragment}`;
    if (!nextVisibleText) {
      if (update.reset && this.lines.delete(key)) {
        this.onLinesChanged(new Map(this.lines));
      }
      return;
    }
    const boundedVisibleText =
      nextVisibleText.length > SIDEBAR_NARRATION_BUFFER_CHARS
        ? sliceUtf16Safe(nextVisibleText, -SIDEBAR_NARRATION_BUFFER_CHARS)
        : nextVisibleText;
    this.visibleText.set(key, boundedVisibleText);
    this.publishThrottled(key, { kind: "text", text: boundedVisibleText });
  }

  private stripInternalRuntimeFragment(key: string, fragment: string): string {
    const pendingDelimiter = this.internalRuntimeDelimiterTails.get(key) ?? "";
    this.internalRuntimeDelimiterTails.delete(key);
    const text = `${pendingDelimiter}${fragment}`;
    let depth = this.internalRuntimeBlockDepth.get(key) ?? 0;
    let cursor = 0;
    let visible = "";

    while (cursor < text.length) {
      const nextBegin = text.indexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN, cursor);
      const nextEnd = text.indexOf(INTERNAL_RUNTIME_CONTEXT_END, cursor);
      if (depth === 0) {
        if (nextBegin === -1 && nextEnd === -1) {
          visible += text.slice(cursor);
          break;
        }
        if (nextEnd !== -1 && (nextBegin === -1 || nextEnd < nextBegin)) {
          // A stray closing delimiter means this fragment may start inside an
          // already-trimmed block. Fail closed until that boundary passes.
          cursor = nextEnd + INTERNAL_RUNTIME_CONTEXT_END.length;
          continue;
        }
        visible += text.slice(cursor, nextBegin);
        depth = 1;
        cursor = nextBegin + INTERNAL_RUNTIME_CONTEXT_BEGIN.length;
        continue;
      }
      if (nextBegin === -1 && nextEnd === -1) {
        break;
      }
      if (nextBegin !== -1 && (nextEnd === -1 || nextBegin < nextEnd)) {
        depth += 1;
        cursor = nextBegin + INTERNAL_RUNTIME_CONTEXT_BEGIN.length;
        continue;
      }
      depth -= 1;
      cursor = nextEnd + INTERNAL_RUNTIME_CONTEXT_END.length;
    }

    const delimiterPrefix = trailingInternalDelimiterPrefix(text);
    if (delimiterPrefix) {
      this.internalRuntimeDelimiterTails.set(key, delimiterPrefix);
      if (depth === 0 && visible.endsWith(delimiterPrefix)) {
        visible = visible.slice(0, -delimiterPrefix.length);
      }
    }
    if (depth > 0) {
      this.internalRuntimeBlockDepth.set(key, depth);
    } else {
      this.internalRuntimeBlockDepth.delete(key);
    }
    return visible;
  }

  private handleAgentEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const record = payload as Record<string, unknown>;
    const key = this.matchingDesiredKey(record.sessionKey, record.agentId);
    if (!key) {
      return;
    }
    this.observeRun(key, record.runId);
    if (this.observerDigests.has(key)) {
      return;
    }
    const data = record.data as Record<string, unknown> | undefined;
    if (record.stream === "tool") {
      const name = typeof data?.name === "string" ? data.name.trim() : "";
      if (!name) {
        return;
      }
      this.publishThrottled(key, {
        kind: "line",
        line: t("chat.sidebar.toolActivity", { tool: name }),
      });
      return;
    }
    if (record.stream !== "assistant") {
      return;
    }
    const text = typeof data?.text === "string" ? data.text : "";
    const delta = typeof data?.delta === "string" ? data.delta : "";
    const consumed = this.consumedStreamLength.get(key) ?? 0;
    if (data?.replace === true) {
      const replacement = text || delta;
      this.publishText(key, {
        streamLength: replacement.length,
        fragment: replacement,
        reset: true,
      });
      return;
    }
    if (text) {
      // Same monotonic-length contract as the chat path: append when the
      // cumulative snapshot grew by exactly this event's delta, else rejoin.
      if (delta && consumed > 0 && text.length - delta.length === consumed) {
        this.publishText(key, { streamLength: text.length, fragment: delta, reset: false });
      } else if (text.length !== consumed) {
        this.publishText(key, { streamLength: text.length, fragment: text, reset: true });
      }
      return;
    }
    if (delta && consumed > 0) {
      this.publishText(key, {
        streamLength: consumed + delta.length,
        fragment: delta,
        reset: false,
      });
    }
    // consumed === 0 with a bare delta: same mid-run-join hazard as the chat
    // path — suppress until a cumulative snapshot aligns the stream.
  }

  private handleObserverEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const record = payload as Record<string, unknown>;
    const key = this.matchingDesiredKey(record.sessionKey, record.agentId);
    const runId = typeof record.runId === "string" ? record.runId.trim() : "";
    if (
      !key ||
      !runId ||
      typeof record.headline !== "string" ||
      typeof record.health !== "string" ||
      typeof record.updatedAt !== "number" ||
      typeof record.revision !== "number"
    ) {
      return;
    }
    this.observeRun(key, runId);
    const digest = { ...record, runId } as unknown as SessionObserverDigest;
    const previous = this.observerDigests.get(key);
    if (
      previous &&
      (previous.revision > digest.revision ||
        (previous.revision === digest.revision && previous.updatedAt >= digest.updatedAt))
    ) {
      return;
    }
    this.clearNarration(key);
    this.observerDigests.set(key, digest);
    this.onObserverDigestsChanged(new Map(this.observerDigests));
  }

  private observeRun(key: string, runIdValue: unknown): void {
    const runId = typeof runIdValue === "string" ? runIdValue.trim() : "";
    if (!runId) {
      return;
    }
    const previousRunId = this.runIds.get(key);
    if (previousRunId && previousRunId !== runId) {
      this.clearLine(key);
    }
    this.runIds.set(key, runId);
  }

  private publishThrottled(key: string, activity: NarrationActivity): void {
    const now = Date.now();
    const throttle = this.throttles.get(key);
    if (!throttle || now - throttle.lastPublishedAt >= SIDEBAR_NARRATION_THROTTLE_MS) {
      if (throttle?.timer) {
        globalThis.clearTimeout(throttle.timer);
      }
      this.throttles.set(key, { lastPublishedAt: now, pending: null, timer: null });
      this.publishActivity(key, activity);
      return;
    }
    throttle.pending = activity;
    if (throttle.timer) {
      return;
    }
    throttle.timer = globalThis.setTimeout(
      () => {
        throttle.timer = null;
        const pending = throttle.pending;
        throttle.pending = null;
        if (!pending || !this.desiredKeys.has(key)) {
          return;
        }
        throttle.lastPublishedAt = Date.now();
        this.publishActivity(key, pending);
      },
      SIDEBAR_NARRATION_THROTTLE_MS - (now - throttle.lastPublishedAt),
    );
  }

  private publishActivity(key: string, activity: NarrationActivity): void {
    const safeText = activity.kind === "text" ? normalizeSidebarNarrationText(activity.text) : null;
    const line = safeText
      ? deriveSidebarNarrationLine(safeText)
      : activity.kind === "line"
        ? activity.line
        : "";
    if (line) {
      this.setLine(key, line);
      return;
    }
    // The activity text is the full visible buffer: normalizing it to nothing
    // means only suppressed content remains (e.g. a replacement that reduced
    // to REPLY_SKIP or a heartbeat), so retract any previously shown line.
    if (activity.kind === "text" && this.lines.delete(key)) {
      this.onLinesChanged(new Map(this.lines));
    }
  }

  private setLine(key: string, line: string): void {
    if (this.lines.get(key) === line) {
      return;
    }
    this.lines.set(key, line);
    this.onLinesChanged(new Map(this.lines));
  }

  private clearLine(key: string): void {
    this.clearNarration(key);
    this.runIds.delete(key);
    if (this.observerDigests.delete(key)) {
      this.onObserverDigestsChanged(new Map(this.observerDigests));
    }
  }

  private clearNarration(key: string): void {
    this.internalRuntimeBlockDepth.delete(key);
    this.internalRuntimeDelimiterTails.delete(key);
    this.consumedStreamLength.delete(key);
    this.visibleText.delete(key);
    const throttle = this.throttles.get(key);
    if (throttle?.timer) {
      globalThis.clearTimeout(throttle.timer);
    }
    this.throttles.delete(key);
    if (this.lines.delete(key)) {
      this.onLinesChanged(new Map(this.lines));
    }
  }

  private clearAllLines(): void {
    for (const throttle of this.throttles.values()) {
      if (throttle.timer) {
        globalThis.clearTimeout(throttle.timer);
      }
    }
    this.internalRuntimeBlockDepth.clear();
    this.internalRuntimeDelimiterTails.clear();
    this.consumedStreamLength.clear();
    this.visibleText.clear();
    this.runIds.clear();
    this.throttles.clear();
    if (this.lines.size > 0) {
      this.lines.clear();
      this.onLinesChanged(new Map());
    }
    if (this.observerDigests.size > 0) {
      this.observerDigests.clear();
      this.onObserverDigestsChanged(new Map());
    }
  }
}
