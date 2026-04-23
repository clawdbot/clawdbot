import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  formatErrorMessage,
  normalizeUsage,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeCompactionHook,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
  type MessagingToolSend,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isJsonObject,
  type CodexServerNotification,
  type CodexThreadItem,
  type CodexTurn,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";

export type CodexAppServerToolTelemetry = {
  didSendViaMessagingTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  successfulCronAdds?: number;
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const CURRENT_TOKEN_USAGE_KEYS = [
  "last",
  "current",
  "lastCall",
  "lastCallUsage",
  "lastTokenUsage",
  "last_token_usage",
] as const;

export class CodexAppServerEventProjector {
  private readonly assistantTextByItem = new Map<string, string>();
  private readonly assistantItemOrder: string[] = [];
  private readonly reasoningTextByItem = new Map<string, string>();
  private readonly planTextByItem = new Map<string, string>();
  private readonly activeItemIds = new Set<string>();
  private readonly completedItemIds = new Set<string>();
  private readonly activeCompactionItemIds = new Set<string>();
  private readonly toolMetas = new Map<string, { toolName: string; meta?: string }>();
  private assistantStarted = false;
  private reasoningStarted = false;
  private reasoningEnded = false;
  private completedTurn: CodexTurn | undefined;
  private promptError: unknown;
  private promptErrorSource: EmbeddedRunAttemptResult["promptErrorSource"] = null;
  private aborted = false;
  private tokenUsage: ReturnType<typeof normalizeUsage>;
  private guardianReviewCount = 0;
  private completedCompactionCount = 0;

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly threadId: string,
    private readonly turnId: string,
  ) {}

  async handleNotification(notification: CodexServerNotification): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params || !this.isNotificationForTurn(params)) {
      return;
    }

    switch (notification.method) {
      case "item/agentMessage/delta":
        await this.handleAssistantDelta(params);
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        await this.handleReasoningDelta(params);
        break;
      case "item/plan/delta":
        this.handlePlanDelta(params);
        break;
      case "turn/plan/updated":
        this.handleTurnPlanUpdated(params);
        break;
      case "item/started":
        await this.handleItemStarted(params);
        break;
      case "item/completed":
        await this.handleItemCompleted(params);
        break;
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
        this.handleGuardianReviewNotification(notification.method, params);
        break;
      case "thread/tokenUsage/updated":
        this.handleTokenUsage(params);
        break;
      case "turn/completed":
        await this.handleTurnCompleted(params);
        break;
      case "error":
        this.promptError = readString(params, "message") ?? "codex app-server error";
        this.promptErrorSource = "prompt";
        break;
      default:
        break;
    }
  }

  buildResult(
    toolTelemetry: CodexAppServerToolTelemetry,
    options?: { yieldDetected?: boolean },
  ): EmbeddedRunAttemptResult {
    const assistantTexts = this.collectAssistantTexts();
    const reasoningText = collectTextValues(this.reasoningTextByItem).join("\n\n");
    const planText = collectTextValues(this.planTextByItem).join("\n\n");
    const lastAssistant =
      assistantTexts.length > 0
        ? this.createAssistantMessage(assistantTexts.join("\n\n"))
        : undefined;
    const messagesSnapshot: AgentMessage[] = [
      {
        role: "user",
        content: this.params.prompt,
        timestamp: Date.now(),
      },
    ];
    // Codex owns the canonical thread. These mirror records keep enough local
    // context for OpenClaw history, search, and future harness switching.
    if (reasoningText) {
      messagesSnapshot.push(this.createAssistantMirrorMessage("Codex reasoning", reasoningText));
    }
    if (planText) {
      messagesSnapshot.push(this.createAssistantMirrorMessage("Codex plan", planText));
    }
    if (lastAssistant) {
      messagesSnapshot.push(lastAssistant);
    }
    const turnFailed = this.completedTurn?.status === "failed";
    const turnInterrupted = this.completedTurn?.status === "interrupted";
    const promptError =
      this.promptError ??
      (turnFailed ? (this.completedTurn?.error?.message ?? "codex app-server turn failed") : null);
    return {
      aborted: this.aborted || turnInterrupted,
      externalAbort: false,
      timedOut: false,
      idleTimedOut: false,
      timedOutDuringCompaction: false,
      promptError,
      promptErrorSource: promptError ? this.promptErrorSource || "prompt" : null,
      sessionIdUsed: this.params.sessionId,
      bootstrapPromptWarningSignaturesSeen: this.params.bootstrapPromptWarningSignaturesSeen,
      bootstrapPromptWarningSignature: this.params.bootstrapPromptWarningSignature,
      messagesSnapshot,
      assistantTexts,
      toolMetas: [...this.toolMetas.values()],
      lastAssistant,
      didSendViaMessagingTool: toolTelemetry.didSendViaMessagingTool,
      messagingToolSentTexts: toolTelemetry.messagingToolSentTexts,
      messagingToolSentMediaUrls: toolTelemetry.messagingToolSentMediaUrls,
      messagingToolSentTargets: toolTelemetry.messagingToolSentTargets,
      toolMediaUrls: toolTelemetry.toolMediaUrls,
      toolAudioAsVoice: toolTelemetry.toolAudioAsVoice,
      successfulCronAdds: toolTelemetry.successfulCronAdds,
      cloudCodeAssistFormatError: false,
      attemptUsage: this.tokenUsage,
      replayMetadata: {
        hadPotentialSideEffects: toolTelemetry.didSendViaMessagingTool,
        replaySafe: !toolTelemetry.didSendViaMessagingTool,
      },
      itemLifecycle: {
        startedCount: this.activeItemIds.size + this.completedItemIds.size,
        completedCount: this.completedItemIds.size,
        activeCount: this.activeItemIds.size,
        ...(this.completedCompactionCount > 0
          ? { compactionCount: this.completedCompactionCount }
          : {}),
      },
      yieldDetected: options?.yieldDetected || false,
      didSendDeterministicApprovalPrompt: this.guardianReviewCount > 0 ? false : undefined,
    };
  }

  markTimedOut(): void {
    this.aborted = true;
    this.promptError = "codex app-server attempt timed out";
    this.promptErrorSource = "prompt";
  }

  isCompacting(): boolean {
    return this.activeCompactionItemIds.size > 0;
  }

  private async handleAssistantDelta(params: JsonObject): Promise<void> {
    const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "assistant";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    if (!this.assistantStarted) {
      this.assistantStarted = true;
      await this.params.onAssistantMessageStart?.();
    }
    this.rememberAssistantItem(itemId);
    const text = `${this.assistantTextByItem.get(itemId) ?? ""}${delta}`;
    this.assistantTextByItem.set(itemId, text);
    // Codex app-server can emit multiple agentMessage items per turn, including
    // intermediate coordination/progress prose. Keep those deltas internal until
    // turn completion chooses the last assistant item as the user-visible reply.
  }

  private async handleReasoningDelta(params: JsonObject): Promise<void> {
    const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "reasoning";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    this.reasoningStarted = true;
    this.reasoningTextByItem.set(itemId, `${this.reasoningTextByItem.get(itemId) ?? ""}${delta}`);
    await this.params.onReasoningStream?.({ text: delta });
  }

  private handlePlanDelta(params: JsonObject): void {
    const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "plan";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    const text = `${this.planTextByItem.get(itemId) ?? ""}${delta}`;
    this.planTextByItem.set(itemId, text);
    this.emitPlanUpdate({ explanation: undefined, steps: splitPlanText(text) });
  }

  private handleTurnPlanUpdated(params: JsonObject): void {
    const plan = Array.isArray(params.plan)
      ? params.plan.flatMap((entry) => {
          if (!isJsonObject(entry)) {
            return [];
          }
          const step = readString(entry, "step");
          const status = readString(entry, "status");
          if (!step) {
            return [];
          }
          return status ? [`${step} (${status})`] : [step];
        })
      : undefined;
    this.emitPlanUpdate({
      explanation: readNullableString(params, "explanation"),
      steps: plan,
    });
  }

  private async handleItemStarted(params: JsonObject): Promise<void> {
    const item = readItem(params.item);
    const itemId = item?.id ?? readString(params, "itemId") ?? readString(params, "id");
    if (itemId) {
      this.activeItemIds.add(itemId);
    }
    if (item?.type === "contextCompaction" && itemId) {
      this.activeCompactionItemIds.add(itemId);
      await runAgentHarnessBeforeCompactionHook({
        sessionFile: this.params.sessionFile,
        messages: this.readMirroredSessionMessages(),
        ctx: {
          runId: this.params.runId,
          agentId: this.params.agentId,
          sessionKey: this.params.sessionKey,
          sessionId: this.params.sessionId,
          workspaceDir: this.params.workspaceDir,
          messageProvider: this.params.messageProvider ?? undefined,
          trigger: this.params.trigger,
          channelId: this.params.messageChannel ?? this.params.messageProvider ?? undefined,
        },
      });
      this.emitAgentEvent({
        stream: "compaction",
        data: {
          phase: "start",
          backend: "codex-app-server",
          threadId: this.threadId,
          turnId: this.turnId,
          itemId,
        },
      });
    }
    this.emitStandardItemEvent({ phase: "start", item });
    this.emitAgentEvent({
      stream: "codex_app_server.item",
      data: { phase: "started", itemId, type: item?.type },
    });
  }

  private async handleItemCompleted(params: JsonObject): Promise<void> {
    const item = readItem(params.item);
    const itemId = item?.id ?? readString(params, "itemId") ?? readString(params, "id");
    if (itemId) {
      this.activeItemIds.delete(itemId);
      this.completedItemIds.add(itemId);
    }
    if (item?.type === "agentMessage" && typeof item.text === "string" && item.text) {
      this.rememberAssistantItem(item.id);
      this.assistantTextByItem.set(item.id, item.text);
    }
    if (item?.type === "plan" && typeof item.text === "string" && item.text) {
      this.planTextByItem.set(item.id, item.text);
      this.emitPlanUpdate({ explanation: undefined, steps: splitPlanText(item.text) });
    }
    if (item?.type === "contextCompaction" && itemId) {
      this.activeCompactionItemIds.delete(itemId);
      this.completedCompactionCount += 1;
      await runAgentHarnessAfterCompactionHook({
        sessionFile: this.params.sessionFile,
        messages: this.readMirroredSessionMessages(),
        compactedCount: -1,
        ctx: {
          runId: this.params.runId,
          agentId: this.params.agentId,
          sessionKey: this.params.sessionKey,
          sessionId: this.params.sessionId,
          workspaceDir: this.params.workspaceDir,
          messageProvider: this.params.messageProvider ?? undefined,
          trigger: this.params.trigger,
          channelId: this.params.messageChannel ?? this.params.messageProvider ?? undefined,
        },
      });
      this.emitAgentEvent({
        stream: "compaction",
        data: {
          phase: "end",
          backend: "codex-app-server",
          threadId: this.threadId,
          turnId: this.turnId,
          itemId,
        },
      });
    }
    this.recordToolMeta(item);
    this.emitStandardItemEvent({ phase: "end", item });
    this.emitAgentEvent({
      stream: "codex_app_server.item",
      data: { phase: "completed", itemId, type: item?.type },
    });
  }

  private handleTokenUsage(params: JsonObject): void {
    const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
    const current =
      (tokenUsage ? readFirstJsonObject(tokenUsage, CURRENT_TOKEN_USAGE_KEYS) : undefined) ??
      readFirstJsonObject(params, CURRENT_TOKEN_USAGE_KEYS);
    if (!current) {
      return;
    }
    const usage = normalizeCodexTokenUsage(current);
    if (usage) {
      this.tokenUsage = usage;
    }
  }

  private handleGuardianReviewNotification(method: string, params: JsonObject): void {
    this.guardianReviewCount += 1;
    const review = isJsonObject(params.review) ? params.review : undefined;
    const action = isJsonObject(params.action) ? params.action : undefined;
    this.emitAgentEvent({
      stream: "codex_app_server.guardian",
      data: {
        method,
        phase: method.endsWith("/started") ? "started" : "completed",
        reviewId: readString(params, "reviewId"),
        targetItemId: readNullableString(params, "targetItemId"),
        decisionSource: readString(params, "decisionSource"),
        status: review ? readString(review, "status") : undefined,
        riskLevel: review ? readString(review, "riskLevel") : undefined,
        userAuthorization: review ? readString(review, "userAuthorization") : undefined,
        rationale: review ? readNullableString(review, "rationale") : undefined,
        actionType: action ? readString(action, "type") : undefined,
      },
    });
  }

  private async handleTurnCompleted(params: JsonObject): Promise<void> {
    const turn = readTurn(params.turn);
    if (!turn || turn.id !== this.turnId) {
      return;
    }
    this.completedTurn = turn;
    if (turn.status === "interrupted") {
      this.aborted = true;
    }
    if (turn.status === "failed") {
      this.promptError = turn.error?.message ?? "codex app-server turn failed";
      this.promptErrorSource = "prompt";
    }
    for (const item of turn.items ?? []) {
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
        this.rememberAssistantItem(item.id);
        this.assistantTextByItem.set(item.id, item.text);
      }
      if (item.type === "plan" && typeof item.text === "string" && item.text) {
        this.planTextByItem.set(item.id, item.text);
        this.emitPlanUpdate({ explanation: undefined, steps: splitPlanText(item.text) });
      }
      this.recordToolMeta(item);
    }
    this.activeCompactionItemIds.clear();
    await this.maybeEndReasoning();
  }

  private async maybeEndReasoning(): Promise<void> {
    if (!this.reasoningStarted || this.reasoningEnded) {
      return;
    }
    this.reasoningEnded = true;
    await this.params.onReasoningEnd?.();
  }

  private emitPlanUpdate(params: { explanation?: string | null; steps?: string[] }): void {
    if (!params.explanation && (!params.steps || params.steps.length === 0)) {
      return;
    }
    this.emitAgentEvent({
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan updated",
        source: "codex-app-server",
        ...(params.explanation ? { explanation: params.explanation } : {}),
        ...(params.steps && params.steps.length > 0 ? { steps: params.steps } : {}),
      },
    });
  }

  private emitStandardItemEvent(params: {
    phase: "start" | "end";
    item: CodexThreadItem | undefined;
  }): void {
    const { item } = params;
    if (!item) {
      return;
    }
    const kind = itemKind(item);
    if (!kind) {
      return;
    }
    this.emitAgentEvent({
      stream: "item",
      data: {
        itemId: item.id,
        phase: params.phase,
        kind,
        title: itemTitle(item),
        status: params.phase === "start" ? "running" : itemStatus(item),
        ...(itemName(item) ? { name: itemName(item) } : {}),
        ...(itemMeta(item) ? { meta: itemMeta(item) } : {}),
      },
    });
  }

  private recordToolMeta(item: CodexThreadItem | undefined): void {
    if (!item) {
      return;
    }
    const toolName = itemName(item);
    if (!toolName) {
      return;
    }
    this.toolMetas.set(item.id, {
      toolName,
      ...(itemMeta(item) ? { meta: itemMeta(item) } : {}),
    });
  }

  private emitAgentEvent(
    event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0],
  ): void {
    try {
      this.params.onAgentEvent?.(event);
    } catch {
      // Downstream event consumers must not corrupt the canonical Codex turn projection.
    }
  }

  private collectAssistantTexts(): string[] {
    const finalText = this.resolveFinalAssistantText();
    return finalText ? [finalText] : [];
  }

  private resolveFinalAssistantText(): string | undefined {
    for (let i = this.assistantItemOrder.length - 1; i >= 0; i -= 1) {
      const itemId = this.assistantItemOrder[i];
      if (!itemId) {
        continue;
      }
      const text = this.assistantTextByItem.get(itemId)?.trim();
      if (text) {
        return text;
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

  private readMirroredSessionMessages(): AgentMessage[] {
    try {
      return SessionManager.open(this.params.sessionFile).buildSessionContext().messages;
    } catch {
      return [];
    }
  }

  private createAssistantMessage(text: string): AssistantMessage {
    const usage: Usage = this.tokenUsage
      ? {
          input: this.tokenUsage.input ?? 0,
          output: this.tokenUsage.output ?? 0,
          cacheRead: this.tokenUsage.cacheRead ?? 0,
          cacheWrite: this.tokenUsage.cacheWrite ?? 0,
          totalTokens:
            this.tokenUsage.total ??
            (this.tokenUsage.input ?? 0) +
              (this.tokenUsage.output ?? 0) +
              (this.tokenUsage.cacheRead ?? 0) +
              (this.tokenUsage.cacheWrite ?? 0),
          cost: ZERO_USAGE.cost,
        }
      : ZERO_USAGE;
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: this.params.model.api ?? "openai-codex-responses",
      provider: this.params.provider,
      model: this.params.modelId,
      usage,
      stopReason: this.aborted ? "aborted" : this.promptError ? "error" : "stop",
      errorMessage: this.promptError ? formatErrorMessage(this.promptError) : undefined,
      timestamp: Date.now(),
    };
  }

  private createAssistantMirrorMessage(title: string, text: string): AssistantMessage {
    return {
      role: "assistant",
      content: [{ type: "text", text: `${title}:\n${text}` }],
      api: this.params.model.api ?? "openai-codex-responses",
      provider: this.params.provider,
      model: this.params.modelId,
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  private isNotificationForTurn(params: JsonObject): boolean {
    const threadId = readString(params, "threadId");
    const turnId = readNotificationTurnId(params);
    return threadId === this.threadId && turnId === this.turnId;
  }
}

function readNotificationTurnId(record: JsonObject): string | undefined {
  return readString(record, "turnId") ?? readNestedTurnId(record);
}

function readNestedTurnId(record: JsonObject): string | undefined {
  const turn = record.turn;
  return isJsonObject(turn) ? readString(turn, "id") : undefined;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNullableString(record: JsonObject, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: JsonObject, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readFirstJsonObject(record: JsonObject, keys: readonly string[]): JsonObject | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isJsonObject(value)) {
      return value;
    }
  }
  return undefined;
}

function readNumberAlias(record: JsonObject, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = readNumber(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizeCodexTokenUsage(record: JsonObject): ReturnType<typeof normalizeUsage> {
  return normalizeUsage({
    input: readNumberAlias(record, ["inputTokens", "input_tokens", "input", "promptTokens"]),
    output: readNumberAlias(record, ["outputTokens", "output_tokens", "output"]),
    cacheRead: readNumberAlias(record, [
      "cachedInputTokens",
      "cached_input_tokens",
      "cacheRead",
      "cache_read",
      "cache_read_input_tokens",
      "cached_tokens",
    ]),
    cacheWrite: readNumberAlias(record, [
      "cacheWrite",
      "cache_write",
      "cacheCreationInputTokens",
      "cache_creation_input_tokens",
    ]),
    total: readNumberAlias(record, ["totalTokens", "total_tokens", "total"]),
  });
}

function splitPlanText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0);
}

function collectTextValues(map: Map<string, string>): string[] {
  return [...map.values()].filter((text) => text.trim().length > 0);
}

function itemKind(
  item: CodexThreadItem,
): "tool" | "command" | "patch" | "search" | "analysis" | undefined {
  switch (item.type) {
    case "dynamicToolCall":
    case "mcpToolCall":
      return "tool";
    case "commandExecution":
      return "command";
    case "fileChange":
      return "patch";
    case "webSearch":
      return "search";
    case "reasoning":
    case "contextCompaction":
      return "analysis";
    default:
      return undefined;
  }
}

function itemTitle(item: CodexThreadItem): string {
  switch (item.type) {
    case "commandExecution":
      return "Command";
    case "fileChange":
      return "File change";
    case "mcpToolCall":
      return "MCP tool";
    case "dynamicToolCall":
      return "Tool";
    case "webSearch":
      return "Web search";
    case "contextCompaction":
      return "Context compaction";
    case "reasoning":
      return "Reasoning";
    default:
      return item.type;
  }
}

function itemStatus(item: CodexThreadItem): "completed" | "failed" | "running" {
  const status = readItemString(item, "status");
  if (status === "failed") {
    return "failed";
  }
  if (status === "inProgress" || status === "running") {
    return "running";
  }
  return "completed";
}

function itemName(item: CodexThreadItem): string | undefined {
  if (item.type === "dynamicToolCall" && typeof item.tool === "string") {
    return item.tool;
  }
  if (item.type === "mcpToolCall" && typeof item.tool === "string") {
    const server = typeof item.server === "string" ? item.server : undefined;
    return server ? `${server}.${item.tool}` : item.tool;
  }
  if (item.type === "commandExecution") {
    return "bash";
  }
  if (item.type === "fileChange") {
    return "apply_patch";
  }
  if (item.type === "webSearch") {
    return "web_search";
  }
  return undefined;
}

function itemMeta(item: CodexThreadItem): string | undefined {
  if (item.type === "commandExecution" && typeof item.command === "string") {
    return item.command;
  }
  if (item.type === "webSearch" && typeof item.query === "string") {
    return item.query;
  }
  return readItemString(item, "status");
}

function readItemString(item: CodexThreadItem, key: string): string | undefined {
  const value = (item as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readItem(value: JsonValue | undefined): CodexThreadItem | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const type = typeof value.type === "string" ? value.type : undefined;
  const id = typeof value.id === "string" ? value.id : undefined;
  if (!type || !id) {
    return undefined;
  }
  return value as CodexThreadItem;
}

function readTurn(value: JsonValue | undefined): CodexTurn | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const id = typeof value.id === "string" ? value.id : undefined;
  const status = typeof value.status === "string" ? value.status : undefined;
  if (!id || !status) {
    return undefined;
  }
  const items = Array.isArray(value.items)
    ? value.items.flatMap((item) => {
        const parsed = readItem(item);
        return parsed ? [parsed] : [];
      })
    : undefined;
  return {
    id,
    status: status as CodexTurn["status"],
    error: isJsonObject(value.error)
      ? {
          message: typeof value.error.message === "string" ? value.error.message : undefined,
        }
      : null,
    items,
  };
}
