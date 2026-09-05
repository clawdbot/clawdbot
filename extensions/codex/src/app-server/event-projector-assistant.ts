import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { isSilentReplyPayloadText } from "openclaw/plugin-sdk/reply-chunking";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createAssistantAsyncMessage as buildAssistantAsyncMessage,
  createAssistantCommentaryMessage as buildAssistantCommentaryMessage,
  createAssistantMessage as buildAssistantMessage,
  type AssistantMessageOptions,
} from "./event-projector-assistant-message.js";
import { shouldClearTerminalPresentationForNativeItem } from "./event-projector-items.js";
import { extractRawAssistantText, readItemString } from "./event-projector-values.js";
import type { CodexThreadItem, JsonObject } from "./protocol.js";
import type { CodexTranscriptCheckpointEntry } from "./transcript-checkpoint.js";

type AgentEvent = Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0];
type AnswerCandidateStatus = "candidate" | "superseded" | "selected";

export class CodexAssistantProjection {
  private readonly assistantTextByItem = new Map<string, string>();
  private readonly assistantItemOrder: string[] = [];
  private readonly assistantTimestampByItem = new Map<string, number>();
  private readonly assistantPhaseByItem = new Map<string, string>();
  private readonly assistantDeliveryByItem = new Map<string, string>();
  private latestTerminalAssistantCandidateItemId: string | undefined;
  private latestTerminalAssistantCandidateSuperseded = false;
  private terminalAssistantCandidateEarlierActiveItemIds = new Set<string>();
  private pendingRawTerminalAssistantEchoItemId: string | undefined;
  private readonly lastCommentaryProgressEventByItem = new Map<
    string,
    { phase: "update" | "end"; text: string }
  >();
  private readonly lastAnswerCandidateEventByItem = new Map<
    string,
    { status: AnswerCandidateStatus; text: string }
  >();
  private visibleAnswerCandidateItemId: string | undefined;
  // Codex emits each typed item completion before its matching raw response item.
  // Pair by protocol order because contributors may rewrite only the typed text.
  private pendingRawCommentaryEchoes = 0;
  // Raw lane re-emissions are the echo channel; typed agentMessage completions are deliberate
  // finals (codex-rs userShell injects as user-role, never assistant). Filtering typed items
  // would drop legitimate verbatim answers ("reply with exactly the command output").
  private readonly rawPromotedAssistantItemIds = new Set<string>();
  private assistantStarted = false;
  private responseModel: string | undefined;
  private streamedPartialAssistantItemId: string | undefined;
  private streamedPartialAssistantItemReplaceable = false;
  // turn/completed.items is a Summary of last_agent_message only. Tool
  // invalidation has to be recorded from the first item notification for each
  // native or dynamic handoff, or a later coda would revive every pre-tool final.
  private persistableAssistantBarrier = 0;
  // A completed answer mirrored before a steer is already durable. Do not
  // replay it as the enclosing turn's terminal answer if Codex emits no coda.
  private persistedAssistantBoundary = false;
  private readonly persistableAssistantBarrierItemIds = new Set<string>();
  private readonly completedAssistantItemIds = new Set<string>();

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly emitAgentEvent: (event: AgentEvent) => void,
    private readonly matchesToolProgressEcho: (text: string) => boolean,
    private readonly nextTranscriptTimestamp: () => number,
    private readonly checkpointCommentary?: (
      itemId: string,
      entry: CodexTranscriptCheckpointEntry,
    ) => void,
  ) {}

  handleNotification(method: string, params: JsonObject): void {
    if (method === "model/rerouted") {
      this.responseModel = readString(params, "toModel") ?? this.responseModel;
    }
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
    const isAsync = this.isAsyncAssistantItem(itemId);
    if (!isCommentary && !isAsync && itemId !== this.latestTerminalAssistantCandidateItemId) {
      this.markTerminalAssistantCandidateSupersededBy();
    }
    if (!this.assistantStarted) {
      this.assistantStarted = true;
      await this.params.onAssistantMessageStart?.();
    }
    this.rememberAssistantItem(itemId);
    const text = `${this.assistantTextByItem.get(itemId) ?? ""}${delta}`;
    this.assistantTextByItem.set(itemId, text);
    if (isAsync) {
      return;
    }
    if (isCommentary) {
      this.emitCommentaryProgress({ itemId, text, phase: "update" });
      return;
    }
    const knownFinalAnswer = this.isFinalAnswerAssistantItem(itemId);
    if (knownFinalAnswer) {
      this.emitAnswerCandidate(itemId, "candidate");
    }
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
        itemId,
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
    this.noteNativeWorkBarrier(item);
    this.rememberAssistantPhase(item);
    if (
      item?.type === "agentMessage" &&
      itemId &&
      !this.isNonTerminalAssistantItem(itemId) &&
      itemId !== this.pendingRawTerminalAssistantEchoItemId
    ) {
      this.pendingRawTerminalAssistantEchoItemId = undefined;
    }
    if (item?.type === "agentMessage" && itemId) {
      this.rememberAssistantItem(itemId);
    }
    if (
      itemId &&
      !this.isNonTerminalAssistantItem(itemId) &&
      itemId !== this.latestTerminalAssistantCandidateItemId
    ) {
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
  ): { itemId: string; message: AssistantMessage; text: string } | undefined {
    if (itemId && item?.type === "agentMessage") {
      this.completedAssistantItemIds.add(itemId);
    }
    this.noteNativeWorkBarrier(item);
    this.rememberAssistantPhase(item);
    if (
      item?.type === "agentMessage" &&
      itemId &&
      !this.isNonTerminalAssistantItem(itemId) &&
      itemId !== this.pendingRawTerminalAssistantEchoItemId
    ) {
      this.pendingRawTerminalAssistantEchoItemId = undefined;
    }
    if (item?.type === "agentMessage" && !this.isNonTerminalAssistantItem(item.id)) {
      this.markLatestTerminalAssistantCandidate(item.id, activeItemIds);
      this.pendingRawTerminalAssistantEchoItemId = item.id;
    } else if (itemId && !this.isNonTerminalAssistantItem(itemId)) {
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
        this.emitCommentaryProgress({ itemId: item.id, text: item.text, phase: "end" });
        this.pendingRawCommentaryEchoes += 1;
      } else if (
        item.text &&
        !this.isAsyncAssistantItem(item.id) &&
        this.isFinalAnswerAssistantItem(item.id)
      ) {
        this.emitAnswerCandidate(item.id, "candidate");
      }
      return this.createAsyncDelivery(item.id);
    }
    return undefined;
  }

  recordSnapshotItem(
    item: CodexThreadItem,
  ): { itemId: string; message: AssistantMessage; text: string } | undefined {
    if (item.type === "agentMessage") {
      this.completedAssistantItemIds.add(item.id);
    }
    this.rememberAssistantPhase(item);
    if (item.type === "agentMessage" && typeof item.text === "string") {
      this.rememberAssistantItem(item.id);
      this.assistantTextByItem.set(item.id, item.text);
      return this.createAsyncDelivery(item.id);
    }
    return undefined;
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
    if (
      text === undefined ||
      (!text &&
        (phase === "commentary" ||
          activeItemIds.size > 0 ||
          readString(item, "type") !== "message"))
    ) {
      return;
    }
    const itemId = rawItemId ?? `raw-assistant-${this.assistantItemOrder.length + 1}`;
    const isIdlessTerminalAssistantAfterCompletedWork =
      candidateWasSupersededBeforeRaw &&
      rawItemId === undefined &&
      pendingTerminalAssistantEchoItemId === undefined &&
      activeItemIds.size === 0;
    if (
      text &&
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
    this.completedAssistantItemIds.add(itemId);
    this.rememberAssistantItem(itemId);
    this.assistantTextByItem.set(itemId, text);
    // Empty raw finals prove an actual stop; retain that fact without publishing fake output.
    if (!text) {
      return;
    }
    this.rawPromotedAssistantItemIds.add(itemId);
    if (phase === "commentary") {
      this.emitCommentaryProgress({ itemId, text, phase: "end" });
    } else {
      this.markLatestTerminalAssistantCandidate(itemId, activeItemIds);
    }
  }

  collectAssistantTexts(): string[] {
    const afterHandoff = this.collectPersistableAssistantTexts(this.persistableAssistantBarrier);
    const audibleAfterHandoff = afterHandoff.filter((text) => !isSilentReplyPayloadText(text));
    if (audibleAfterHandoff.length > 0) {
      return audibleAfterHandoff;
    }
    // A post-handoff silent token is the new terminal identity. Recover a
    // pre-barrier answer only when that segment has no persistable text.
    if (afterHandoff.length > 0) {
      return afterHandoff.slice(-1);
    }
    if (this.persistedAssistantBoundary) {
      return [];
    }
    const recoveredAudible = this.collectPersistableAssistantTexts(0).filter(
      (text) => !isSilentReplyPayloadText(text),
    );
    if (recoveredAudible.length > 0) {
      return recoveredAudible.slice(-1);
    }
    const recovered = this.resolveFinalAssistantTextItem()?.text;
    return recovered ? [recovered] : [];
  }

  collectCommentaryMessages(): Array<{ itemId: string; message: AssistantMessage }> {
    return this.assistantItemOrder.flatMap((itemId) => {
      const message = this.readCommentaryMessage(itemId);
      return message ? [{ itemId, message }] : [];
    });
  }

  private readCommentaryMessage(itemId: string): AssistantMessage | undefined {
    const text = this.assistantTextByItem.get(itemId)?.trim();
    const timestamp = this.assistantTimestampByItem.get(itemId);
    return this.isCommentaryAssistantItem(itemId) && text && timestamp !== undefined
      ? buildAssistantCommentaryMessage(this.params, text, itemId, timestamp)
      : undefined;
  }

  collectAsyncMessages(): Array<{ itemId: string; message: AssistantMessage }> {
    return this.assistantItemOrder.flatMap((itemId) => {
      if (!this.isAsyncAssistantItem(itemId)) {
        return [];
      }
      const text = this.assistantTextByItem.get(itemId)?.trim();
      const timestamp = this.assistantTimestampByItem.get(itemId);
      if (!text || timestamp === undefined) {
        return [];
      }
      return [
        {
          itemId,
          message: buildAssistantAsyncMessage(this.params, text, itemId, timestamp),
        },
      ];
    });
  }

  collectCompletedAssistantMessages(
    completedItemIds: ReadonlySet<string>,
    options: AssistantMessageOptions,
  ): Array<{ itemId: string; message: AssistantMessage }> {
    // Steering history covers visible completed items even across final-answer
    // handoffs. Mirror identities deduplicate them across subsequent steers.
    return this.assistantItemOrder.flatMap((itemId) => {
      const text = this.assistantTextByItem.get(itemId)?.trim();
      if (
        !completedItemIds.has(itemId) ||
        this.isNonTerminalAssistantItem(itemId) ||
        !text ||
        isSilentReplyPayloadText(text) ||
        this.isToolProgressEchoText(itemId, text)
      ) {
        return [];
      }
      const message = this.createAssistantMessage(text, options);
      const timestamp = this.assistantTimestampByItem.get(itemId) ?? message.timestamp;
      return [{ itemId, message: { ...message, timestamp } }];
    });
  }

  markAssistantBoundaryPersisted(itemId: string): void {
    const index = this.assistantItemOrder.indexOf(itemId);
    if (index >= 0) {
      this.persistableAssistantBarrier = Math.max(this.persistableAssistantBarrier, index + 1);
      this.persistedAssistantBoundary = true;
    }
  }

  finalizeAnswerCandidate(turn: { status?: string; items?: CodexThreadItem[] }): void {
    if (turn.status !== "completed") {
      this.supersedeVisibleAnswerCandidate();
      return;
    }
    const turnItems = turn.items ?? [];
    const authoritativeIndex = turnItems.findLastIndex((item) => {
      if (
        item.type !== "agentMessage" ||
        typeof item.text !== "string" ||
        item.text.trim().length === 0
      ) {
        return false;
      }
      const phase = readItemString(item, "phase");
      const delivery = readItemString(item, "delivery");
      return delivery !== "async" && (phase === "final_answer" || phase === undefined);
    });
    const authoritative = authoritativeIndex >= 0 ? turnItems[authoritativeIndex] : undefined;
    const invalidatedByLaterTool = turnItems
      .slice(authoritativeIndex + 1)
      .some(shouldClearTerminalPresentationForNativeItem);
    if (
      invalidatedByLaterTool ||
      (authoritative?.id === this.latestTerminalAssistantCandidateItemId &&
        this.latestTerminalAssistantCandidateSuperseded)
    ) {
      this.supersedeVisibleAnswerCandidate();
      return;
    }
    const itemId = authoritative?.id ?? this.visibleAnswerCandidateItemId;
    if (!itemId) {
      return;
    }
    if (itemId !== this.visibleAnswerCandidateItemId) {
      this.supersedeVisibleAnswerCandidate();
      this.visibleAnswerCandidateItemId = itemId;
    }
    this.emitAnswerCandidate(itemId, "selected");
  }

  hasAssistantItemTextForSynthesis(): boolean {
    for (let i = this.assistantItemOrder.length - 1; i >= 0; i -= 1) {
      const itemId = this.assistantItemOrder[i];
      if (!itemId || this.isNonTerminalAssistantItem(itemId)) {
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
        this.isNonTerminalAssistantItem(itemId) ||
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
    const message = buildAssistantMessage(this.params, text, options);
    return this.responseModel ? { ...message, responseModel: this.responseModel } : message;
  }

  private rememberAssistantPhase(item: CodexThreadItem | undefined): void {
    if (item?.type !== "agentMessage") {
      return;
    }
    const phase = readItemString(item, "phase");
    if (phase) {
      this.assistantPhaseByItem.set(item.id, phase);
    }
    const delivery = readItemString(item, "delivery");
    if (delivery) {
      this.assistantDeliveryByItem.set(item.id, delivery);
    }
  }

  private isCommentaryAssistantItem(itemId: string): boolean {
    return this.assistantPhaseByItem.get(itemId) === "commentary";
  }

  private isAsyncAssistantItem(itemId: string): boolean {
    return this.assistantDeliveryByItem.get(itemId) === "async";
  }

  private isNonTerminalAssistantItem(itemId: string): boolean {
    return this.isCommentaryAssistantItem(itemId) || this.isAsyncAssistantItem(itemId);
  }

  private isFinalAnswerAssistantItem(itemId: string): boolean {
    return this.assistantPhaseByItem.get(itemId) === "final_answer";
  }

  private emitCommentaryProgress(params: {
    itemId: string;
    text: string;
    phase: "update" | "end";
  }): void {
    const progressText = params.text.trim();
    // Codex completes an item with the same text as its last delta. Channels
    // need that boundary before their first notifying post, so agents must not
    // collapse completion into a text-only duplicate or invent a timer instead.
    const previous = this.lastCommentaryProgressEventByItem.get(params.itemId);
    if (!progressText || (previous?.phase === params.phase && previous.text === progressText)) {
      return;
    }
    this.lastCommentaryProgressEventByItem.set(params.itemId, {
      phase: params.phase,
      text: progressText,
    });
    this.emitAgentEvent({
      stream: "item",
      data: {
        itemId: params.itemId,
        kind: "preamble",
        title: "Preamble",
        phase: params.phase,
        progressText,
        source: "codex-app-server",
      },
    });
  }

  private emitAnswerCandidate(itemId: string, status: AnswerCandidateStatus): void {
    const text = this.assistantTextByItem.get(itemId)?.trim();
    if (!text) {
      return;
    }
    if (status === "candidate" && this.visibleAnswerCandidateItemId !== itemId) {
      this.supersedeVisibleAnswerCandidate();
      this.visibleAnswerCandidateItemId = itemId;
    }
    const previous = this.lastAnswerCandidateEventByItem.get(itemId);
    if (previous?.status === status && previous.text === text) {
      return;
    }
    this.lastAnswerCandidateEventByItem.set(itemId, { status, text });
    this.emitAgentEvent({
      stream: "item",
      data: {
        itemId,
        kind: "answer_candidate",
        title: "Answer candidate",
        phase: "update",
        status,
        progressText: text,
        source: "codex-app-server",
        // Activity consumes this event directly; channel progress must never render it.
        hideFromChannelProgress: true,
      },
    });
  }

  private supersedeVisibleAnswerCandidate(): void {
    const itemId = this.visibleAnswerCandidateItemId;
    if (!itemId) {
      return;
    }
    this.emitAnswerCandidate(itemId, "superseded");
    this.visibleAnswerCandidateItemId = undefined;
  }

  private markLatestTerminalAssistantCandidate(
    itemId: string,
    activeItemIds: ReadonlySet<string>,
  ): void {
    this.latestTerminalAssistantCandidateItemId = itemId;
    this.latestTerminalAssistantCandidateSuperseded = false;
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
    this.terminalAssistantCandidateEarlierActiveItemIds.clear();
    this.supersedeVisibleAnswerCandidate();
  }

  private resolveFinalAssistantTextItem(): { itemId: string; text: string } | undefined {
    for (let i = this.assistantItemOrder.length - 1; i >= 0; i -= 1) {
      const itemId = this.assistantItemOrder[i];
      if (!itemId) {
        continue;
      }
      const text = this.assistantTextByItem.get(itemId)?.trim();
      if (this.isNonTerminalAssistantItem(itemId)) {
        continue;
      }
      if (text && !this.isToolProgressEchoText(itemId, text)) {
        return { itemId, text };
      }
    }
    return undefined;
  }

  private collectPersistableAssistantTexts(minIndex: number): string[] {
    let texts: string[] = [];
    let replaceable = false;
    // Walk time order. Unphased text replaces the current segment. Explicit
    // finals accumulate unless they follow a replacement. Silent payloads
    // never replace; they only ride along for post-handoff identity.
    for (let index = minIndex; index < this.assistantItemOrder.length; index += 1) {
      const itemId = this.assistantItemOrder[index];
      if (!itemId || this.isNonTerminalAssistantItem(itemId)) {
        continue;
      }
      const text = this.assistantTextByItem.get(itemId)?.trim();
      if (!text || this.isToolProgressEchoText(itemId, text)) {
        continue;
      }
      if (isSilentReplyPayloadText(text)) {
        texts.push(text);
        continue;
      }
      const isTerminalFinal = this.assistantPhaseByItem.get(itemId) === "final_answer";
      if (!isTerminalFinal || replaceable) {
        texts = [text];
        replaceable = !isTerminalFinal;
        continue;
      }
      texts.push(text);
    }
    return texts;
  }

  private noteNativeWorkBarrier(item: CodexThreadItem | undefined): void {
    if (!item || !shouldAdvancePersistableAssistantBarrier(item)) {
      return;
    }
    if (item.id && this.persistableAssistantBarrierItemIds.has(item.id)) {
      return;
    }
    if (item.id) {
      this.persistableAssistantBarrierItemIds.add(item.id);
    }
    this.persistableAssistantBarrier = this.assistantItemOrder.length;
  }

  private rememberAssistantItem(itemId: string): void {
    if (!itemId) {
      return;
    }
    if (!this.assistantTimestampByItem.has(itemId)) {
      this.assistantItemOrder.push(itemId);
      this.assistantTimestampByItem.set(itemId, this.nextTranscriptTimestamp());
    }
    if (this.isCommentaryAssistantItem(itemId)) {
      this.checkpointCommentary?.(itemId, {
        read: () => this.readCommentaryMessage(itemId),
        ready: () => this.completedAssistantItemIds.has(itemId),
      });
    }
  }

  private createAsyncDelivery(
    itemId: string,
  ): { itemId: string; message: AssistantMessage; text: string } | undefined {
    if (!this.isAsyncAssistantItem(itemId)) {
      return undefined;
    }
    const text = this.assistantTextByItem.get(itemId);
    const timestamp = this.assistantTimestampByItem.get(itemId);
    if (!text?.trim() || timestamp === undefined) {
      return undefined;
    }
    return {
      itemId,
      message: buildAssistantAsyncMessage(this.params, text, itemId, timestamp),
      text,
    };
  }

  private isToolProgressEchoText(itemId: string, text: string): boolean {
    return this.rawPromotedAssistantItemIds.has(itemId) && this.matchesToolProgressEcho(text);
  }
}

function shouldAdvancePersistableAssistantBarrier(item: CodexThreadItem): boolean {
  // Sleep is a Codex public Sleep handoff, not mutating presentation work.
  // Record it here so a later final cannot join the pre-sleep answer.
  return (
    shouldClearTerminalPresentationForNativeItem(item) ||
    item.type === "dynamicToolCall" ||
    item.type === "sleep"
  );
}
