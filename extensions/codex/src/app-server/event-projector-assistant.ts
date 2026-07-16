import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import {
  createAssistantMessage as buildAssistantMessage,
  createAssistantMirrorMessage as buildAssistantMirrorMessage,
  type AssistantMessageOptions,
} from "./event-projector-assistant-message.js";
import { extractRawAssistantText, readItemString, readString } from "./event-projector-values.js";
import type { CodexThreadItem, JsonObject } from "./protocol.js";

type AgentEvent = Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0];

export class CodexAssistantProjection {
  private readonly assistantTextByItem = new Map<string, string>();
  private readonly assistantItemOrder: string[] = [];
  private readonly assistantPhaseByItem = new Map<string, string>();
  private latestCompletedItemId: string | undefined;
  private latestCompletedTerminalAssistantItemId: string | undefined;
  private latestTerminalAssistantCandidateItemId: string | undefined;
  private latestTerminalAssistantCandidateSuperseded = false;
  private latestTerminalAssistantCandidateCanReleaseAfterToolHandoff = false;
  private terminalAssistantCandidateEarlierActiveItemIds = new Set<string>();
  private pendingRawTerminalAssistantEchoItemId: string | undefined;
  private readonly lastCommentaryProgressTextByItem = new Map<string, string>();
  // Codex emits each typed item completion before its matching raw response item.
  // Pair by protocol order because contributors may rewrite only the typed text.
  private pendingRawCommentaryEchoes = 0;
  // Raw lane re-emissions are the echo channel; typed agentMessage completions are deliberate
  // finals (codex-rs userShell injects as user-role, never assistant). Filtering typed items
  // would drop legitimate verbatim answers ("reply with exactly the command output").
  private readonly rawPromotedAssistantItemIds = new Set<string>();
  private assistantStarted = false;
  private streamedPartialAssistantItemId: string | undefined;
  private streamedPartialAssistantItemReplaceable = false;

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly emitAgentEvent: (event: AgentEvent) => void,
    private readonly matchesToolProgressEcho: (text: string) => boolean,
  ) {}

  hasCompletedTerminalAssistantText(completedItemIds: ReadonlySet<string>): boolean {
    const latestCompletedItemId = this.latestCompletedTerminalAssistantItemId;
    if (!latestCompletedItemId) {
      return false;
    }
    const finalItem = this.resolveFinalAssistantTextItem();
    return (
      this.latestCompletedItemId === latestCompletedItemId &&
      finalItem?.itemId === latestCompletedItemId &&
      completedItemIds.has(latestCompletedItemId)
    );
  }

  getLatestTerminalAssistantCandidate(): { itemId: string; hasText: boolean } | undefined {
    const itemId = this.latestTerminalAssistantCandidateItemId;
    if (!itemId) {
      return undefined;
    }
    const text = this.assistantTextByItem.get(itemId)?.trim();
    return {
      itemId,
      hasText: Boolean(text && !this.isToolProgressEchoText(itemId, text)),
    };
  }

  hasLatestTerminalAssistantCandidateText(): boolean {
    return (
      !this.latestTerminalAssistantCandidateSuperseded &&
      this.getLatestTerminalAssistantCandidate()?.hasText === true
    );
  }

  canReleaseLatestTerminalAssistantAfterToolHandoff(): boolean {
    return (
      this.latestTerminalAssistantCandidateCanReleaseAfterToolHandoff &&
      this.hasLatestTerminalAssistantCandidateText()
    );
  }

  async handleAssistantDelta(params: JsonObject): Promise<void> {
    const itemId = readString(params, "itemId") ?? "assistant";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    if (itemId !== this.pendingRawTerminalAssistantEchoItemId) {
      this.pendingRawTerminalAssistantEchoItemId = undefined;
    }
    // Deltas carry no phase; item/started has already recorded it.
    const isCommentary = this.isCommentaryAssistantItem(itemId);
    if (!isCommentary && itemId !== this.latestTerminalAssistantCandidateItemId) {
      this.markTerminalAssistantCandidateSupersededBy();
    }
    if (!this.assistantStarted) {
      this.assistantStarted = true;
      await this.params.onAssistantMessageStart?.();
    }
    this.rememberAssistantItem(itemId);
    const text = `${this.assistantTextByItem.get(itemId) ?? ""}${delta}`;
    this.assistantTextByItem.set(itemId, text);
    if (isCommentary) {
      this.emitCommentaryProgress({ itemId, text });
      return;
    }
    const knownFinalAnswer = this.shouldStreamAssistantPartial(itemId);
    const replace =
      this.streamedPartialAssistantItemId !== undefined &&
      this.streamedPartialAssistantItemId !== itemId;
    // Codex defines final_answer as terminal text. Replacement mode is for
    // phase-unknown/provisional items; append-only consumers cannot retract bytes.
    if (replace && (!knownFinalAnswer || this.streamedPartialAssistantItemReplaceable)) {
      this.streamedPartialAssistantItemReplaceable = true;
    } else if (this.streamedPartialAssistantItemId === undefined) {
      this.streamedPartialAssistantItemReplaceable = !knownFinalAnswer;
    }
    this.streamedPartialAssistantItemId = itemId;
    const replaceable = this.streamedPartialAssistantItemReplaceable;
    const replacement = replace && replaceable;
    const streamPayload = {
      text,
      delta: replacement ? "" : delta,
      ...(replacement ? { replace: true as const } : {}),
    };
    this.emitAgentEvent({
      stream: "assistant",
      data: {
        ...streamPayload,
        ...(replaceable ? { replaceable: true as const } : {}),
      },
    });
    // Legacy channel preview callbacks are append-oriented and do not all
    // understand replacement snapshots.
    if (knownFinalAnswer && !replaceable) {
      await this.params.onPartialReply?.(streamPayload);
    }
  }

  recordItemStarted(item: CodexThreadItem | undefined, itemId: string | undefined): void {
    if (
      item?.type === "agentMessage" &&
      itemId &&
      itemId !== this.pendingRawTerminalAssistantEchoItemId
    ) {
      this.pendingRawTerminalAssistantEchoItemId = undefined;
    }
    this.rememberAssistantPhase(item);
    if (itemId && itemId !== this.latestTerminalAssistantCandidateItemId) {
      this.markTerminalAssistantCandidateSupersededBy(itemId, {
        preserveEarlierActiveItem: true,
      });
      if (this.latestTerminalAssistantCandidateSuperseded) {
        this.pendingRawTerminalAssistantEchoItemId = undefined;
      }
    }
  }

  recordItemCompleted(
    item: CodexThreadItem | undefined,
    itemId: string | undefined,
    activeItemIds: ReadonlySet<string>,
  ): void {
    if (
      item?.type === "agentMessage" &&
      itemId &&
      itemId !== this.pendingRawTerminalAssistantEchoItemId
    ) {
      this.pendingRawTerminalAssistantEchoItemId = undefined;
    }
    if (itemId) {
      this.latestCompletedItemId = itemId;
    }
    this.rememberAssistantPhase(item);
    if (item?.type === "agentMessage" && !this.isCommentaryAssistantItem(item.id)) {
      this.latestCompletedTerminalAssistantItemId = item.id;
      this.markLatestTerminalAssistantCandidate(item.id, activeItemIds);
      this.pendingRawTerminalAssistantEchoItemId = item.id;
    } else if (itemId) {
      this.markTerminalAssistantCandidateSupersededBy(itemId, {
        preserveEarlierActiveItem: true,
      });
      if (this.latestTerminalAssistantCandidateSuperseded) {
        this.pendingRawTerminalAssistantEchoItemId = undefined;
      }
    }
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      this.rememberAssistantItem(item.id);
      this.assistantTextByItem.set(item.id, item.text);
      if (item.text && this.isCommentaryAssistantItem(item.id)) {
        this.emitCommentaryProgress({ itemId: item.id, text: item.text });
        this.pendingRawCommentaryEchoes += 1;
      }
    }
  }

  recordSnapshotItem(item: CodexThreadItem): void {
    this.rememberAssistantPhase(item);
    if (item.type === "agentMessage" && typeof item.text === "string") {
      this.rememberAssistantItem(item.id);
      this.assistantTextByItem.set(item.id, item.text);
    }
  }

  handleRawResponseItemCompleted(item: JsonObject, activeItemIds: ReadonlySet<string>): void {
    const role = readString(item, "role");
    const phase = readString(item, "phase");
    const rawItemId = readString(item, "id");
    const candidateWasSupersededBeforeRaw = this.latestTerminalAssistantCandidateSuperseded;
    const pendingTerminalAssistantEchoItemId = this.pendingRawTerminalAssistantEchoItemId;
    const isPendingTerminalAssistantEcho =
      role === "assistant" &&
      phase !== "commentary" &&
      pendingTerminalAssistantEchoItemId !== undefined &&
      (rawItemId === undefined || rawItemId === pendingTerminalAssistantEchoItemId);
    if (pendingTerminalAssistantEchoItemId !== undefined && !isPendingTerminalAssistantEcho) {
      this.pendingRawTerminalAssistantEchoItemId = undefined;
    }
    if (!isPendingTerminalAssistantEcho) {
      this.latestCompletedItemId = undefined;
      this.markTerminalAssistantCandidateSupersededBy(rawItemId);
    }
    if (role !== "assistant") {
      return;
    }
    if (phase === "commentary" && this.pendingRawCommentaryEchoes > 0) {
      this.pendingRawCommentaryEchoes -= 1;
      return;
    }
    const text = extractRawAssistantText(item);
    if (isPendingTerminalAssistantEcho) {
      const typedItemId = pendingTerminalAssistantEchoItemId;
      this.pendingRawTerminalAssistantEchoItemId = undefined;
      // Contributors may rewrite the typed completion without rewriting its raw echo.
      if (this.assistantTextByItem.get(typedItemId)?.trim() || !text) {
        return;
      }
      this.rememberAssistantItem(typedItemId);
      this.assistantTextByItem.set(typedItemId, text);
      return;
    }
    if (!text) {
      return;
    }
    const itemId = rawItemId ?? `raw-assistant-${this.assistantItemOrder.length + 1}`;
    const isIdlessTerminalAssistantAfterCompletedWork =
      candidateWasSupersededBeforeRaw &&
      rawItemId === undefined &&
      pendingTerminalAssistantEchoItemId === undefined &&
      activeItemIds.size === 0;
    if (
      phase !== "commentary" &&
      candidateWasSupersededBeforeRaw &&
      itemId !== this.streamedPartialAssistantItemId &&
      !isIdlessTerminalAssistantAfterCompletedWork
    ) {
      return;
    }
    if (phase) {
      this.assistantPhaseByItem.set(itemId, phase);
    }
    this.rememberAssistantItem(itemId);
    this.assistantTextByItem.set(itemId, text);
    this.rawPromotedAssistantItemIds.add(itemId);
    if (phase === "commentary") {
      this.emitCommentaryProgress({ itemId, text });
    } else {
      this.markLatestTerminalAssistantCandidate(itemId, activeItemIds, {
        canReleaseAfterToolHandoff: isIdlessTerminalAssistantAfterCompletedWork,
      });
    }
  }

  collectAssistantTexts(): string[] {
    const finalText = this.resolveFinalAssistantTextItem()?.text;
    return finalText ? [finalText] : [];
  }

  hasAssistantItemTextForSynthesis(): boolean {
    for (let i = this.assistantItemOrder.length - 1; i >= 0; i -= 1) {
      const itemId = this.assistantItemOrder[i];
      if (!itemId || this.assistantPhaseByItem.get(itemId) === "commentary") {
        continue;
      }
      const text = this.assistantTextByItem.get(itemId);
      if (text && text.length > 0) {
        return true;
      }
    }
    return false;
  }

  createCurrentAttemptAssistantMessage(
    options: AssistantMessageOptions,
  ): AssistantMessage | undefined {
    for (let i = this.assistantItemOrder.length - 1; i >= 0; i -= 1) {
      const itemId = this.assistantItemOrder[i];
      if (
        !itemId ||
        this.isCommentaryAssistantItem(itemId) ||
        !this.assistantTextByItem.has(itemId)
      ) {
        continue;
      }
      const text = this.assistantTextByItem.get(itemId) ?? "";
      const normalizedText = text.trim();
      if (normalizedText && this.isToolProgressEchoText(itemId, normalizedText)) {
        continue;
      }
      return this.createAssistantMessage(text, options);
    }
    return undefined;
  }

  createAssistantMessage(text: string, options: AssistantMessageOptions): AssistantMessage {
    return buildAssistantMessage(this.params, text, options);
  }

  createAssistantMirrorMessage(title: string, text: string): AssistantMessage {
    return buildAssistantMirrorMessage(this.params, title, text);
  }

  private rememberAssistantPhase(item: CodexThreadItem | undefined): void {
    if (item?.type !== "agentMessage") {
      return;
    }
    const phase = readItemString(item, "phase");
    if (phase) {
      this.assistantPhaseByItem.set(item.id, phase);
    }
  }

  private isCommentaryAssistantItem(itemId: string): boolean {
    return this.assistantPhaseByItem.get(itemId) === "commentary";
  }

  private shouldStreamAssistantPartial(itemId: string): boolean {
    return this.assistantPhaseByItem.get(itemId) === "final_answer";
  }

  private emitCommentaryProgress(params: { itemId: string; text: string }): void {
    const progressText = params.text.replace(/\s+/g, " ").trim();
    if (
      !progressText ||
      this.lastCommentaryProgressTextByItem.get(params.itemId) === progressText
    ) {
      return;
    }
    this.lastCommentaryProgressTextByItem.set(params.itemId, progressText);
    this.emitAgentEvent({
      stream: "item",
      data: {
        itemId: params.itemId,
        kind: "preamble",
        title: "Preamble",
        phase: "update",
        progressText,
        source: "codex-app-server",
      },
    });
  }

  private markLatestTerminalAssistantCandidate(
    itemId: string,
    activeItemIds: ReadonlySet<string>,
    options?: { canReleaseAfterToolHandoff?: boolean },
  ): void {
    this.latestTerminalAssistantCandidateItemId = itemId;
    this.latestTerminalAssistantCandidateSuperseded = false;
    this.latestTerminalAssistantCandidateCanReleaseAfterToolHandoff =
      options?.canReleaseAfterToolHandoff === true;
    this.terminalAssistantCandidateEarlierActiveItemIds = new Set(activeItemIds);
  }

  private markTerminalAssistantCandidateSupersededBy(
    itemId?: string,
    options?: { preserveEarlierActiveItem?: boolean },
  ): void {
    if (!this.latestTerminalAssistantCandidateItemId) {
      return;
    }
    // Preserve app-server ordering where an item already active at assistant
    // completion reports its delayed completion afterward.
    if (itemId && this.terminalAssistantCandidateEarlierActiveItemIds.has(itemId)) {
      if (!options?.preserveEarlierActiveItem) {
        this.terminalAssistantCandidateEarlierActiveItemIds.delete(itemId);
      }
      return;
    }
    this.latestTerminalAssistantCandidateSuperseded = true;
    this.latestTerminalAssistantCandidateCanReleaseAfterToolHandoff = false;
    this.terminalAssistantCandidateEarlierActiveItemIds.clear();
  }

  private resolveFinalAssistantTextItem(): { itemId: string; text: string } | undefined {
    for (let i = this.assistantItemOrder.length - 1; i >= 0; i -= 1) {
      const itemId = this.assistantItemOrder[i];
      if (!itemId) {
        continue;
      }
      const text = this.assistantTextByItem.get(itemId)?.trim();
      if (this.assistantPhaseByItem.get(itemId) === "commentary") {
        continue;
      }
      if (text && !this.isToolProgressEchoText(itemId, text)) {
        return { itemId, text };
      }
    }
    return undefined;
  }

  private rememberAssistantItem(itemId: string): void {
    if (!itemId || this.assistantItemOrder.includes(itemId)) {
      return;
    }
    this.assistantItemOrder.push(itemId);
  }

  private isToolProgressEchoText(itemId: string, text: string): boolean {
    return this.rawPromotedAssistantItemIds.has(itemId) && this.matchesToolProgressEcho(text);
  }
}
