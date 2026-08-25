/**
 * Notification → accumulator + event emission for the Claude app-server bridge.
 *
 * Mirrors extensions/codex/src/app-server/event-projector.ts at smaller
 * scope. Pulled out of run-attempt.ts so the turn runner stays orchestration-
 * focused (promise + idle timer + unsubscribe lifecycle) while this module
 * owns the notification shape readers, current-turn filtering, accumulator
 * mutation, native-tool AfterToolCall emission, and assistant/reasoning
 * stream emission.
 *
 * Caller flow inside runTurn:
 *
 *   const projector = new ClaudeAppServerEventProjector({...});
 *   client.onNotification((notif) => {
 *     const outcome = projector.processNotification(notif);
 *     if (outcome?.kind === "completed") resolve();
 *     else if (outcome?.kind === "failed") reject(outcome.error);
 *   });
 *   // ... await settle ...
 *   projector.finalize(); // fold deltas into acc.assistantTexts/reasoning
 */

import {
  emitAgentEvent as emitGlobalAgentEvent,
  embeddedAgentLog,
  normalizeUsage,
  runAgentHarnessAfterToolCallHook,
  type EmbeddedRunAttemptParams,
  type NormalizedUsage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readTurn, readTurnCompletedNotification } from "./protocol-validators.js";
import type { JsonValue, RpcNotification, Turn } from "./types.js";

/**
 * Emit an agent event to BOTH the global agent-event bus (with
 * sessionKey attached, so channel renderers can scope by session) AND
 * the per-attempt `params.onAgentEvent` callback (which the
 * attempt-execution layer threads through to channel/progress
 * subscribers — e.g. Discord's "streaming.mode = progress" renderer).
 *
 * Mirrors codex's wrapper at extensions/codex/src/app-server/event-projector.ts.
 * Before this helper the bridge only emitted to the global bus and
 * channel renderers using the per-attempt callback (Discord progress
 * mode included) never saw tool/item events for claude turns.
 */
function emitProjectedAgentEvent(
  params: EmbeddedRunAttemptParams,
  event: { stream: string; data: Record<string, unknown> },
): void {
  try {
    emitGlobalAgentEvent({
      runId: params.runId,
      stream: event.stream,
      data: event.data,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  } catch (error) {
    embeddedAgentLog.debug("claude-bridge: global emitAgentEvent threw", { error });
  }
  try {
    const maybePromise = params.onAgentEvent?.(event);
    void Promise.resolve(maybePromise).catch((error: unknown) => {
      embeddedAgentLog.debug("claude-bridge: per-attempt onAgentEvent rejected", { error });
    });
  } catch (error) {
    // Downstream consumers must not corrupt the canonical projection.
    embeddedAgentLog.debug("claude-bridge: per-attempt onAgentEvent threw", { error });
  }
}

/** Transport prefix the Claude CLI uses for our loopback OpenClaw MCP tools. */
const OPENCLAW_MCP_TOOL_PREFIX = "mcp__openclaw__";

/**
 * Whether dynamic-tools.ts already dispatched this call — and therefore already
 * fired AfterToolCall for it.
 *
 * `dynamicToolCall` is the obvious case. The subtle one is that the bridge serves
 * OpenClaw tools as an IN-PROCESS MCP SERVER, so the CLI reports them as ordinary
 * `mcpToolCall` items carrying the raw `mcp__openclaw__*` transport name. Those are
 * bridge-owned too: treating them as native fires AfterToolCall a SECOND time for a
 * call dynamic-tools.ts already reported, which is precisely the double-count the
 * guard in recordToolCompletion exists to prevent. Field evidence: across 3 days of
 * gateway logs, prefixed and unprefixed after_tool_call counts pair off exactly
 * (heartbeat_respond 99/99, vestige_dream 9/9, sessions_spawn 8/8, vestige_search
 * 3/3) while before_tool_call is never prefixed (0/118) — one population counted
 * twice, not two populations.
 */
function isBridgeOwnedToolCall(item: Record<string, unknown>): boolean {
  if (item.type === "dynamicToolCall") {
    return true;
  }
  const name = extractItemName(item);
  return typeof name === "string" && name.startsWith(OPENCLAW_MCP_TOOL_PREFIX);
}

/**
 * The normalized stop-reason vocabulary openclaw's AgentMessage uses
 * (`packages/llm-core/src/types.ts` StopReason). The claude bridge reports a
 * turn-level `status`, not a per-message Anthropic `stop_reason`, so this is
 * the honest signal available at turn/completed — mapped by
 * `mapTurnStatusToStopReason` below and threaded onto the final assistant
 * message in the snapshot (openclaw-0ld C3).
 */
export type SnapshotStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type ProjectorAccumulator = {
  assistantTexts: string[];
  toolMetas: Array<{ toolName: string; meta?: string }>;
  reasoning: string;
  itemCount: number;
  toolCalls: Map<
    string,
    {
      name: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
      startedAt?: number;
      isDynamic?: boolean;
    }
  >;
  usage?: NormalizedUsage;
  // Real stop reason for the turn, captured from turn/completed → Turn.status.
  // Undefined until the turn settles; buildMessagesSnapshot falls back to
  // "stop" for the final assistant message when unset.
  stopReason?: SnapshotStopReason;
};

/**
 * Map the bridge's turn-level status to openclaw's StopReason vocabulary.
 * The bridge does not surface Anthropic's per-message stop_reason (end_turn /
 * max_tokens / refusal) on the Turn snapshot, so "completed" collapses to
 * "stop" — we cannot distinguish a length cutoff from a natural end here.
 * "inProgress" should never reach a completed handler; treat it as unknown.
 */
export function mapTurnStatusToStopReason(
  status: Turn["status"] | undefined,
): SnapshotStopReason | undefined {
  switch (status) {
    case "completed":
      return "stop";
    case "interrupted":
      return "aborted";
    case "failed":
      return "error";
    default:
      return undefined;
  }
}

export type ProjectorHookContext = {
  runId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  channelId?: string;
};

export type ProjectorOutcome =
  | { kind: "completed"; turn?: Turn }
  | { kind: "failed"; error: Error }
  | null;

export class ClaudeAppServerEventProjector {
  private readonly textParts: string[] = [];
  private readonly reasoningParts: string[] = [];
  // Per-item delta accumulator for agentMessage blocks so item/completed can
  // emit a preamble bullet with the block's text even when the completed
  // item payload omits the text field.
  private readonly textPartsByItemId = new Map<string, string[]>();
  // Holds the most recent completed agentMessage. If another item starts
  // afterward, the held item is intermediate prose — flush as preamble.
  // The item still held at turn completion is the final reply — its text
  // becomes textParts (→ lastAssistant) instead of a preamble emission.
  // This mirrors codex's commentary-vs-final split without requiring the
  // server to tag items. When the server *does* tag items (claude bridge
  // >= 0.2.7 emits phase: "commentary" | "final_answer"), the positional
  // heuristic still drives in-stream emission; phase is used as a
  // tiebreaker in the turn/completed fallback below.
  private pendingAgentMessage: { itemId: string | undefined; text: string } | undefined;
  // Item ids we've already emitted as preamble bullets. The turn/completed
  // fallback (which scans turn.items for a trailing agentMessage when no
  // block is held) must skip these or it would re-deliver intermediate
  // prose as the final reply. This is the bridge-side guard against the
  // edge case where a turn ends without a follow-up text block.
  private readonly emittedPreambleItemIds = new Set<string>();
  // Item ids the server explicitly tagged with phase: "final_answer" via
  // an item/updated notification. Server-tagged finals take priority over
  // the positional last-agentMessage heuristic when reconciling
  // turn.items at turn/completed.
  private readonly serverTaggedFinalItemIds = new Set<string>();
  private settled = false;
  private tokenUsage: NormalizedUsage | undefined;
  // Guards onReasoningEnd against firing on a turn that never streamed any
  // reasoning (codex's reasoningStarted/reasoningEnded pattern, see
  // extensions/codex/src/app-server/event-projector-reasoning.ts).
  private reasoningEndFired = false;

  constructor(
    private readonly turnId: string,
    private readonly acc: ProjectorAccumulator,
    private readonly params: EmbeddedRunAttemptParams,
    private readonly hookContext: ProjectorHookContext,
  ) {}

  /**
   * Returns true if the notification's turn identity matches the projector's
   * turnId. Used by callers to gate per-turn idle-timer resets, so they
   * don't reset on stray notifications belonging to a different turn on
   * the same shared client.
   */
  matchesTurn(notif: RpcNotification): boolean {
    const p = notif.params as Record<string, unknown> | undefined;
    if (!p) {
      return false;
    }
    const ntid = typeof p.turnId === "string" ? p.turnId : undefined;
    const turnObj = p.turn as { id?: string } | undefined;
    const directMatch = ntid === this.turnId;
    const nestedMatch =
      turnObj !== undefined && typeof turnObj.id === "string" && turnObj.id === this.turnId;
    return directMatch || nestedMatch;
  }

  /**
   * Dispatch one server notification. Mutates the accumulator and emits
   * downstream agent events as side effects. Returns a terminal outcome
   * (completed/failed) when the turn naturally ends; null otherwise.
   * Returns null for notifications that don't match the current turn,
   * leaving caller-side settle state untouched.
   */
  processNotification(notif: RpcNotification): ProjectorOutcome {
    if (this.settled) {
      return null;
    }
    if (!this.matchesTurn(notif)) {
      return null;
    }
    const p = notif.params as Record<string, unknown> | undefined;
    if (!p) {
      return null;
    }
    switch (notif.method) {
      case "item/started":
      case "item/completed":
        this.handleItemLifecycle(notif.method, p);
        return null;
      case "item/updated":
        this.handleItemUpdated(p);
        return null;
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(p);
        return null;
      case "item/reasoning/delta":
        this.handleReasoningDelta(p);
        return null;
      case "thread/tokenUsage/updated":
        this.handleTokenUsage(p);
        return null;
      case "turn/error":
        this.settled = true;
        return { kind: "failed", error: this.errorFromTurnErrorPayload(p) };
      case "turn/completed":
        this.settled = true;
        return this.handleTurnCompleted(p);
      default:
        return null;
    }
  }

  /** Mark settled externally (e.g. after an idle-timeout or abort). */
  markSettled(): void {
    this.settled = true;
  }

  /** Fold streamed deltas into the accumulator. Call once after settle. */
  finalize(): void {
    // Abnormal-settle salvage: when settle happens before turn/completed
    // (idle timeout, abort), pendingAgentMessage and per-item buffers may
    // still hold uncommitted text. Drain them so lastAssistant reflects
    // whatever did arrive instead of silently dropping it. Order matters:
    // pendingAgentMessage was the most-recently-completed block; the
    // per-item buffers may hold deltas from an item that never completed.
    if (this.textParts.length === 0) {
      if (this.pendingAgentMessage) {
        this.textParts.push(this.pendingAgentMessage.text);
        this.pendingAgentMessage = undefined;
      } else if (this.textPartsByItemId.size > 0) {
        const latest = Array.from(this.textPartsByItemId.values()).pop();
        const text = latest?.join("").trim();
        if (text) {
          this.textParts.push(text);
        }
      }
    }
    if (this.textParts.length > 0) {
      this.acc.assistantTexts = [this.textParts.join("")];
    }
    if (this.reasoningParts.length > 0) {
      this.acc.reasoning = this.reasoningParts.join("");
    }
    if (this.tokenUsage) {
      this.acc.usage = this.tokenUsage;
    }
  }

  // ── internal handlers ──────────────────────────────────────────────────

  private handleItemLifecycle(
    method: "item/started" | "item/completed",
    p: Record<string, unknown>,
  ): void {
    const item = p.item as Record<string, unknown> | undefined;
    if (!item) {
      return;
    }
    if (method === "item/completed") {
      this.acc.itemCount += 1;
    }
    const isTool = isToolItem(item);
    if (method === "item/started") {
      // Any new item arriving confirms that the held agentMessage (if any)
      // is intermediate prose, not the final reply. Flush it as a preamble
      // now so M_draft surfaces it alongside the upcoming tool/reasoning
      // line.
      this.flushPendingAgentMessageAsPreamble();
      if (isTool) {
        this.recordToolStart(item);
        // Tools: emit the durable item event so codex/Discord renderers
        // produce a stable per-tool channel line (matches codex's pattern).
        emitItemEvent(this.params, "start", item);
      }
      // Non-tool items (agentMessage, reasoning, SDK lifecycle blocks like
      // session-status / mcp-session) are intentionally not emitted on
      // start. AgentMessage's preamble is deferred until we know whether
      // it is intermediate (flushed above on the next item/started) or
      // final (consumed by handleTurnCompleted into textParts). SDK
      // lifecycle items aren't user-visible in codex and shouldn't be
      // surfaced for claude either.
      return;
    }
    // item/completed
    if (isTool) {
      this.recordToolCompletion(item);
      emitToolEvent(this.params, "result", item);
      emitItemEvent(this.params, "end", item);
      return;
    }
    if (item.type === "agentMessage") {
      const itemId = typeof item.id === "string" ? item.id : undefined;
      // Prefer the completed item's text field when populated; fall back
      // to the per-item delta accumulator from handleAgentMessageDelta.
      const inlineText = typeof item.text === "string" ? item.text : "";
      const accumulatedText = itemId ? (this.textPartsByItemId.get(itemId)?.join("") ?? "") : "";
      const text = (inlineText || accumulatedText).trim();
      if (itemId) {
        this.textPartsByItemId.delete(itemId);
      }
      if (text) {
        // Hold the item. If the next event is another item/started, this
        // block is intermediate prose and gets flushed as a preamble; if
        // the next event is turn/completed, this is the final reply and
        // its text is moved into textParts → lastAssistant by
        // handleTurnCompleted (with no preamble emission).
        if (this.pendingAgentMessage) {
          this.flushPendingAgentMessageAsPreamble();
        }
        this.pendingAgentMessage = { itemId, text };
      }
    }
    // Other non-tool items (reasoning, SDK lifecycle) and the agentMessage
    // branch above are terminal here: suppressed, nothing left to emit.
  }

  private handleItemUpdated(p: Record<string, unknown>): void {
    const item = p.item as Record<string, unknown> | undefined;
    if (!item) {
      return;
    }
    if (item.type === "agentMessage") {
      // Server (claude bridge >= 0.2.7) emits item/updated with
      // phase: "final_answer" for the trailing agentMessage block of an
      // assistant message whose stop_reason resolves to "end_turn".
      // Record the itemId so the turn/completed fallback can prefer
      // server-tagged finals over positional last-agentMessage guessing.
      // This block is still in pendingAgentMessage at this point (the
      // tag arrives between item/completed and turn/completed), so the
      // primary "pendingAgentMessage -> textParts" path in
      // handleTurnCompleted still runs as before — the tag only matters
      // when that positional path can't fire.
      const phase = typeof item.phase === "string" ? item.phase : null;
      const itemId = typeof item.id === "string" ? item.id : undefined;
      if (phase === "final_answer" && itemId) {
        this.serverTaggedFinalItemIds.add(itemId);
      }
      return;
    }
    if (!isToolItem(item)) {
      return;
    }
    // The server emits item/updated for tool calls once the input JSON
    // streamed in by Anthropic is parsed (between item/started — where
    // args were still null — and item/completed). Refresh the
    // accumulator's args + re-emit stream:"tool" with phase:"update" so
    // channel renderers can replace the bare "🛠️ <tool>" line with
    // "🛠️ <tool> <command>". Matches codex's per-tool command rendering.
    const itemId = typeof item.id === "string" ? item.id : undefined;
    if (itemId) {
      const existing = this.acc.toolCalls.get(itemId);
      const updatedArgs = item.arguments ?? item.input;
      if (existing) {
        this.acc.toolCalls.set(itemId, { ...existing, args: updatedArgs });
      }
    }
    emitToolEvent(this.params, "update", item);
  }

  private recordToolStart(item: Record<string, unknown>): void {
    const toolName = extractItemName(item) ?? "unknown";
    this.acc.toolMetas.push({ toolName });
    const itemId = typeof item.id === "string" ? item.id : undefined;
    if (itemId) {
      this.acc.toolCalls.set(itemId, {
        name: toolName,
        args: item.arguments ?? item.input,
        startedAt: Date.now(),
        isDynamic: isBridgeOwnedToolCall(item),
      });
    }
    // Mirror codex's stream:"tool" phase:"start" emission so Discord/Slack/
    // etc. can render "🛠️ <tool> <preview>" stubs in real time instead of
    // waiting for the whole turn to finish.
    emitToolEvent(this.params, "start", item);
  }

  private recordToolCompletion(item: Record<string, unknown>): void {
    const itemId = typeof item.id === "string" ? item.id : undefined;
    if (!itemId) {
      return;
    }
    const prev = this.acc.toolCalls.get(itemId);
    // Server's makeDynamicToolCallItem emits `contentItems` (an array of
    // {type:"inputText"|"inputImage", ...}) — NOT `result`. Read whichever
    // is present so dynamic-tool output makes it into messagesSnapshot for
    // replay/provenance. Native tool items use `result`; both are accepted.
    const payload = item.contentItems ?? item.result;
    const merged = {
      ...(prev ?? { name: extractItemName(item) ?? "unknown" }),
      result: payload,
      isError: item.status === "failed" || item.error != null,
    };
    this.acc.toolCalls.set(itemId, merged);
    // Fire AfterToolCall for NATIVE tools only. Dynamic tool calls already
    // fire AfterToolCall inside dynamic-tools.ts when the openclaw bridge
    // invokes the AnyAgentTool, so firing here too would double-count.
    if (!merged.isDynamic && !isBridgeOwnedToolCall(item)) {
      const args =
        merged.args && typeof merged.args === "object" && !Array.isArray(merged.args)
          ? (merged.args as Record<string, unknown>)
          : {};
      void runAgentHarnessAfterToolCallHook({
        toolName: merged.name,
        toolCallId: itemId,
        runId: this.hookContext.runId,
        agentId: this.hookContext.agentId,
        sessionId: this.hookContext.sessionId,
        sessionKey: this.hookContext.sessionKey,
        channelId: this.hookContext.channelId,
        startArgs: args,
        result: payload as JsonValue,
        ...(merged.isError
          ? { error: typeof item.error === "string" ? item.error : "tool failed" }
          : {}),
        ...(merged.startedAt != null ? { startedAt: merged.startedAt } : {}),
      });
    }
  }

  private handleAgentMessageDelta(p: Record<string, unknown>): void {
    if (typeof p.delta !== "string") {
      return;
    }
    // Accumulate only per-item; the global textParts is populated at
    // turn completion from the *final* agentMessage block (the one still
    // held in pendingAgentMessage). Intermediate blocks go to M_draft as
    // preamble (via flushPendingAgentMessageAsPreamble) and must not
    // contribute to lastAssistant, or the final reply would re-deliver
    // the intermediate prose and clobber the in-channel transcript.
    const itemId = typeof p.itemId === "string" ? p.itemId : undefined;
    if (itemId) {
      let buf = this.textPartsByItemId.get(itemId);
      if (!buf) {
        buf = [];
        this.textPartsByItemId.set(itemId, buf);
      }
      buf.push(p.delta);
    }
    // Intentionally no stream:"assistant" emission — see comment in
    // handleItemLifecycle. Codex never emits this stream either; renderers
    // treat it as a final-reply replace and overwrite the tool/preamble
    // draft preview. Final text is delivered via messagesSnapshot.
  }

  private flushPendingAgentMessageAsPreamble(): void {
    if (!this.pendingAgentMessage) {
      return;
    }
    const { itemId, text } = this.pendingAgentMessage;
    this.pendingAgentMessage = undefined;
    if (itemId) {
      this.emittedPreambleItemIds.add(itemId);
    }
    emitProjectedAgentEvent(this.params, {
      stream: "item",
      data: {
        ...(itemId ? { itemId } : {}),
        kind: "preamble",
        title: "Preamble",
        phase: "update",
        progressText: text,
      },
    });
  }

  private handleReasoningDelta(p: Record<string, unknown>): void {
    if (typeof p.delta !== "string") {
      return;
    }
    this.reasoningParts.push(p.delta);
    const accumulated = this.reasoningParts.join("");
    emitReasoningDeltaEvent(this.params, p.delta, accumulated);
    // Codex streams reasoning to the user-visible channel transcript via the
    // dedicated onReasoningStream/onReasoningEnd callback pair (see
    // extensions/codex/src/app-server/event-projector-reasoning.ts), which is
    // the actual plumbing Discord/Slack/Telegram/etc. delivery listens on —
    // NOT the generic emitAgentEvent bus above (that's a "stream": "reasoning"
    // tag the shared AgentEventStream union doesn't recognize; nothing renders
    // it). Without this call, reasoning was captured into acc.reasoning for
    // diagnostics but never reached any channel regardless of /reasoning on
    // or reasoningDefault config (openclaw-q7i). isReasoningSnapshot: true
    // matches codex's contract — text is the full accumulated reasoning so
    // far, not just this delta.
    void this.params.onReasoningStream?.({ text: accumulated, isReasoningSnapshot: true });
  }

  private handleTokenUsage(p: Record<string, unknown>): void {
    const tokenUsage = p.tokenUsage as Record<string, unknown> | undefined;
    const current =
      (tokenUsage ? readFirstRecord(tokenUsage, CURRENT_TOKEN_USAGE_KEYS) : undefined) ??
      readFirstRecord(p, CURRENT_TOKEN_USAGE_KEYS);
    if (!current) {
      return;
    }
    const usage = normalizeTokenUsage(current);
    if (usage) {
      this.tokenUsage = usage;
    }
  }

  private errorFromTurnErrorPayload(p: Record<string, unknown>): Error {
    const err = p.error as { message?: string } | undefined;
    return new Error(`Claude turn error: ${err?.message ?? "turn/error"}`);
  }

  private handleTurnCompleted(p: Record<string, unknown>): ProjectorOutcome {
    // readTurnCompletedNotification returns undefined for a malformed
    // payload (missing turn.id, unknown status enum). Falling through to
    // undefined preserves the prior cast-tolerant behavior without
    // committing to a value we can't trust.
    const parsedNotification = readTurnCompletedNotification(p);
    const turn: Turn | undefined =
      parsedNotification?.turn ?? readTurn((p as { turn?: unknown }).turn);
    // Capture the real stop reason so buildMessagesSnapshot can stamp the
    // final assistant message with what the bridge actually reported instead
    // of a hardcoded "stop" (openclaw-0ld C3). Left undefined on a malformed /
    // inProgress turn, where the snapshot falls back to "stop".
    this.acc.stopReason = mapTurnStatusToStopReason(turn?.status);
    if (turn?.status === "failed") {
      return {
        kind: "failed",
        error: new Error(`Claude turn failed: ${turn.error?.message ?? "unknown"}`),
      };
    }
    // The agentMessage still held at turn completion is the final reply.
    // Move its text into textParts (consumed by finalize() →
    // acc.assistantTexts → lastAssistant) and do NOT emit a preamble for
    // it — the channel renderer will deliver this text as the final reply,
    // separately from the M_draft transcript.
    if (this.pendingAgentMessage) {
      this.textParts.push(this.pendingAgentMessage.text);
      this.pendingAgentMessage = undefined;
    } else if (turn?.items && this.textParts.length === 0) {
      // Fallback for the case where we never observed item/completed for
      // the trailing agentMessage (event loss / abrupt settlement) OR
      // the turn legitimately ended with no final reply (e.g.
      // commentary + tool with no follow-up text). Reconcile against
      // turn.items in three priority tiers; each tier excludes itemIds
      // we've already emitted as preambles so we never re-deliver the
      // in-channel transcript text as the final reply.
      //
      // 1. Server-tagged final (phase: "final_answer", or recorded via
      //    item/updated). Trust the server's explicit signal.
      // 2. turn.items entry with phase: "final_answer" (carried in the
      //    authoritative turn snapshot when the projector missed the
      //    item/updated for some reason).
      // 3. Last agentMessage in turn.items that isn't already a
      //    preamble — final positional fallback, behaves like the
      //    pre-phase-tagging server.
      const isPreamble = (id: string | undefined): boolean =>
        id !== undefined && this.emittedPreambleItemIds.has(id);
      const picked = pickFinalAgentMessageFromTurn(
        turn.items,
        this.serverTaggedFinalItemIds,
        isPreamble,
      );
      if (picked) {
        this.textParts.push(picked);
      }
    }
    // Close the reasoning stream exactly once, only when this turn actually
    // streamed reasoning — mirrors codex's maybeEndReasoning() call at the
    // same turn-completed point (extensions/codex/src/app-server/
    // event-projector.ts). Channel renderers use onReasoningEnd to finalize/
    // collapse the live reasoning block; skipping it on a no-reasoning turn
    // avoids an empty open/close pair.
    if (this.reasoningParts.length > 0 && !this.reasoningEndFired) {
      this.reasoningEndFired = true;
      void this.params.onReasoningEnd?.();
    }
    return { kind: "completed", turn };
  }
}

function pickFinalAgentMessageFromTurn(
  items: ReadonlyArray<{ id?: string; type?: string; text?: string; phase?: string | null }>,
  serverTaggedFinalItemIds: ReadonlySet<string>,
  isPreamble: (id: string | undefined) => boolean,
): string | undefined {
  // Tier 1: server-tagged final, recorded via item/updated.
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (
      item?.type === "agentMessage" &&
      typeof item.id === "string" &&
      serverTaggedFinalItemIds.has(item.id) &&
      typeof item.text === "string" &&
      item.text
    ) {
      return item.text;
    }
  }
  // Tier 2: phase: "final_answer" carried in the turn snapshot.
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (
      item?.type === "agentMessage" &&
      item.phase === "final_answer" &&
      typeof item.text === "string" &&
      item.text
    ) {
      return item.text;
    }
  }
  // Tier 3: last agentMessage that isn't already a preamble (legacy
  // behavior for servers that don't tag phase). Skipping preambles
  // closes the duplicate-final edge case observed when a turn ends with
  // commentary + tool and no follow-up reply.
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (
      item?.type === "agentMessage" &&
      typeof item.text === "string" &&
      item.text &&
      !isPreamble(typeof item.id === "string" ? item.id : undefined)
    ) {
      return item.text;
    }
  }
  return undefined;
}

// ── pure helpers (exported for testability) ────────────────────────────────

export function isToolItem(item: Record<string, unknown>): boolean {
  return item.type === "dynamicToolCall" || item.type === "toolCall" || item.type === "mcpToolCall";
}

export function extractItemName(item: Record<string, unknown>): string | undefined {
  if (typeof item.name === "string") {
    return item.name;
  }
  if (typeof item.tool === "string") {
    return item.tool;
  }
  return undefined;
}

// ── event emission helpers (also used standalone by run-attempt) ────────────

export function emitToolEvent(
  params: EmbeddedRunAttemptParams,
  phase: "start" | "update" | "result",
  item: Record<string, unknown>,
): void {
  const toolName = extractItemName(item);
  if (!toolName) {
    return;
  }
  const itemId = typeof item.id === "string" ? item.id : undefined;
  const status = typeof item.status === "string" ? item.status : undefined;
  const args =
    item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)
      ? (item.arguments as Record<string, unknown>)
      : item.input && typeof item.input === "object" && !Array.isArray(item.input)
        ? (item.input as Record<string, unknown>)
        : undefined;
  const data: Record<string, unknown> = { phase, name: toolName };
  if (itemId) {
    data.itemId = itemId;
    data.toolCallId = itemId;
  }
  if ((phase === "start" || phase === "update") && args) {
    data.args = args;
  }
  if (phase === "result") {
    if (status) {
      data.status = status;
    }
    data.isError = status === "failed" || item.error != null;
    if (item.result && typeof item.result === "object" && !Array.isArray(item.result)) {
      data.result = item.result as Record<string, unknown>;
    }
  }
  emitProjectedAgentEvent(params, { stream: "tool", data });
}

export function emitItemEvent(
  params: EmbeddedRunAttemptParams,
  phase: "start" | "end",
  item: Record<string, unknown>,
): void {
  const itemId = typeof item.id === "string" ? item.id : undefined;
  const rawKind = typeof item.type === "string" ? item.type : undefined;
  // Normalize tool item kinds ("toolCall"/"dynamicToolCall"/"mcpToolCall")
  // to "tool" so channel/ACP renderers that key on kind === "tool" treat
  // the item the same way they treat codex's tool items.
  const isTool = isToolItem(item);
  const kind = isTool ? "tool" : rawKind;
  const name = extractItemName(item);
  const title = name ?? rawKind;
  const status = typeof item.status === "string" ? item.status : undefined;
  const data: Record<string, unknown> = { phase };
  if (itemId) {
    data.itemId = itemId;
  }
  if (kind) {
    data.kind = kind;
  }
  if (title) {
    data.title = title;
  }
  if (status) {
    data.status = status;
  }
  if (isTool) {
    if (name) {
      data.name = name;
    }
    if (itemId) {
      data.toolCallId = itemId;
    }
  }
  emitProjectedAgentEvent(params, { stream: "item", data });
}

export function emitReasoningDeltaEvent(
  params: EmbeddedRunAttemptParams,
  delta: string,
  accumulated: string,
): void {
  emitProjectedAgentEvent(params, {
    stream: "reasoning",
    data: { delta, text: accumulated },
  });
}

// ── token usage helpers ────────────────────────────────────────────────────

const CURRENT_TOKEN_USAGE_KEYS = [
  "last",
  "current",
  "lastCall",
  "lastCallUsage",
  "lastTokenUsage",
  "last_token_usage",
] as const;

function readFirstRecord(
  obj: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      return val as Record<string, unknown>;
    }
  }
  return undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const val = obj[key];
  return typeof val === "number" ? val : undefined;
}

function readNumberAlias(
  obj: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const key of keys) {
    const val = readNumber(obj, key);
    if (val !== undefined) {
      return val;
    }
  }
  return undefined;
}

function normalizeTokenUsage(record: Record<string, unknown>): NormalizedUsage | undefined {
  const promptTotalInput = readNumberAlias(record, [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
  ]);
  const cacheRead = readNumberAlias(record, [
    "cachedInputTokens",
    "cached_input_tokens",
    "cacheRead",
    "cache_read",
    "cache_read_input_tokens",
    "cached_tokens",
  ]);
  const input =
    promptTotalInput !== undefined && cacheRead !== undefined
      ? Math.max(0, promptTotalInput - cacheRead)
      : (promptTotalInput ?? readNumber(record, "input"));

  return normalizeUsage({
    input,
    output: readNumberAlias(record, ["outputTokens", "output_tokens", "output"]),
    cacheRead,
    cacheWrite: readNumberAlias(record, [
      "cacheWrite",
      "cache_write",
      "cacheCreationInputTokens",
      "cache_creation_input_tokens",
    ]),
    total: readNumberAlias(record, ["totalTokens", "total_tokens", "total"]),
  });
}
