import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { runEmbeddedPiAgent, type EmbeddedPiRunResult } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCommitmentTimezone, resolveCommitmentsConfig } from "./config.js";
import {
  buildCommitmentExtractionPrompt,
  hydrateCommitmentExtractionItem,
  parseCommitmentExtractionOutput,
  persistCommitmentExtractionResult,
} from "./extraction.js";
import type {
  CommitmentExtractionBatchResult,
  CommitmentExtractionItem,
  CommitmentScope,
} from "./types.js";

type TimerHandle = ReturnType<typeof setTimeout>;
type ModelRef = { provider: string; model: string };

type CommitmentExtractionEnqueueInput = CommitmentScope & {
  cfg?: OpenClawConfig;
  nowMs?: number;
  userText: string;
  assistantText?: string;
  sourceMessageId?: string;
  sourceRunId?: string;
};

type CommitmentExtractionRuntime = {
  extractBatch?: (params: {
    cfg?: OpenClawConfig;
    items: CommitmentExtractionItem[];
  }) => Promise<CommitmentExtractionBatchResult>;
  resolveDefaultModel?: (params: { cfg: OpenClawConfig; agentId?: string }) => ModelRef;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  forceInTests?: boolean;
};

const log = createSubsystemLogger("commitments");
const TERMINAL_EXTRACTION_FAILURE_COOLDOWN_MS = 15 * 60_000;

let runtime: CommitmentExtractionRuntime = {};
let queue: Array<Omit<CommitmentExtractionItem, "existingPending"> & { cfg?: OpenClawConfig }> = [];
let timer: TimerHandle | null = null;
let draining = false;
let queueOverflowWarned = false;
let terminalFailureCooldownUntilByAgent = new Map<string, number>();

function shouldDisableBackgroundExtractionForTests(): boolean {
  if (runtime.forceInTests) {
    return false;
  }
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

function setTimer(callback: () => void, delayMs: number): TimerHandle {
  const handle = runtime.setTimer
    ? runtime.setTimer(callback, delayMs)
    : setTimeout(callback, delayMs);
  if (typeof handle === "object" && "unref" in handle && typeof handle.unref === "function") {
    handle.unref();
  }
  return handle;
}

function clearTimer(handle: TimerHandle): void {
  (runtime.clearTimer ?? clearTimeout)(handle);
}

export function configureCommitmentExtractionRuntime(next: CommitmentExtractionRuntime): void {
  runtime = next;
}

export function resetCommitmentExtractionRuntimeForTests(): void {
  if (timer) {
    clearTimer(timer);
  }
  runtime = {};
  queue = [];
  timer = null;
  draining = false;
  queueOverflowWarned = false;
  terminalFailureCooldownUntilByAgent = new Map();
}

function buildItemId(params: CommitmentExtractionEnqueueInput, nowMs: number): string {
  const source = normalizeOptionalString(params.sourceMessageId) ? "message" : "turn";
  return `${source}:${nowMs.toString(36)}:${randomUUID()}`;
}

function isUsefulText(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function enqueueCommitmentExtraction(input: CommitmentExtractionEnqueueInput): boolean {
  const resolved = resolveCommitmentsConfig(input.cfg);
  const nowMs = input.nowMs ?? Date.now();
  const agentId = normalizeOptionalString(input.agentId) ?? "";
  const sessionKey = normalizeOptionalString(input.sessionKey) ?? "";
  const channel = normalizeOptionalString(input.channel) ?? "";
  if (
    !resolved.enabled ||
    shouldDisableBackgroundExtractionForTests() ||
    (agentId ? nowMs < (terminalFailureCooldownUntilByAgent.get(agentId) ?? 0) : false) ||
    !isUsefulText(input.userText) ||
    !isUsefulText(input.assistantText) ||
    !agentId ||
    !sessionKey ||
    !channel
  ) {
    return false;
  }
  if (queue.length >= resolved.extraction.queueMaxItems) {
    if (!queueOverflowWarned) {
      log.warn("commitment extraction queue full; dropping hidden extraction request", {
        queued: queue.length,
        max: resolved.extraction.queueMaxItems,
      });
      queueOverflowWarned = true;
    }
    return false;
  }
  queue.push({
    itemId: buildItemId(input, nowMs),
    nowMs,
    timezone: resolveCommitmentTimezone(input.cfg),
    agentId,
    sessionKey,
    channel,
    ...(input.accountId?.trim() ? { accountId: input.accountId.trim() } : {}),
    ...(input.to?.trim() ? { to: input.to.trim() } : {}),
    ...(input.threadId?.trim() ? { threadId: input.threadId.trim() } : {}),
    ...(input.senderId?.trim() ? { senderId: input.senderId.trim() } : {}),
    userText: input.userText.trim(),
    ...(input.assistantText?.trim() ? { assistantText: input.assistantText.trim() } : {}),
    ...(input.sourceMessageId?.trim() ? { sourceMessageId: input.sourceMessageId.trim() } : {}),
    ...(input.sourceRunId?.trim() ? { sourceRunId: input.sourceRunId.trim() } : {}),
    cfg: input.cfg,
  });
  if (!timer) {
    timer = setTimer(() => {
      timer = null;
      void drainCommitmentExtractionQueue().catch((err) => {
        log.warn("commitment extraction failed", { error: String(err) });
      });
    }, resolved.extraction.debounceMs);
  }
  return true;
}

function isTerminalExtractionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\bNo API key found\b/i.test(message) ||
    /\bUnknown model\b/i.test(message) ||
    /\bAuth profile credentials are missing or expired\b/i.test(message) ||
    /\bOAuth token refresh failed\b/i.test(message) ||
    /\bmissing credential\b/i.test(message) ||
    /\bmissing credentials\b/i.test(message) ||
    /\bmissing_api_key\b/i.test(message) ||
    /\binvalid_grant\b/i.test(message)
  );
}

function openTerminalFailureCooldown(agentId: string, error: unknown): void {
  terminalFailureCooldownUntilByAgent.set(
    agentId,
    Date.now() + TERMINAL_EXTRACTION_FAILURE_COOLDOWN_MS,
  );
  queue = queue.filter((item) => item.agentId !== agentId);
  log.warn("commitment extraction disabled temporarily after terminal model/auth failure", {
    agentId,
    cooldownMs: TERMINAL_EXTRACTION_FAILURE_COOLDOWN_MS,
    error: String(error),
  });
}

function resolveExtractionSessionFile(agentId: string, runId: string): string {
  return path.join(
    resolveStateDir(),
    "commitments",
    "extractor-sessions",
    agentId,
    `${runId}.jsonl`,
  );
}

function joinPayloadText(result: EmbeddedPiRunResult): string {
  return (
    result.payloads
      ?.map((payload) => payload.text)
      .filter((text): text is string => Boolean(text?.trim()))
      .join("\n")
      .trim() ?? ""
  );
}

async function resolveDefaultModel(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<ModelRef> {
  if (runtime.resolveDefaultModel) {
    return runtime.resolveDefaultModel(params);
  }
  const { resolveCommitmentDefaultModelRef } = await import("./model-selection.runtime.js");
  return resolveCommitmentDefaultModelRef(params);
}

async function defaultExtractBatch(params: {
  cfg?: OpenClawConfig;
  items: CommitmentExtractionItem[];
}): Promise<CommitmentExtractionBatchResult> {
  const cfg = params.cfg ?? {};
  const first = params.items[0];
  if (!first) {
    return { candidates: [] };
  }
  const resolved = resolveCommitmentsConfig(cfg);
  const runId = `commitments-${randomUUID()}`;
  const modelRef = await resolveDefaultModel({ cfg, agentId: first.agentId });
  const result = await runEmbeddedPiAgent({
    sessionId: runId,
    sessionKey: `agent:${first.agentId}:commitments:${runId}`,
    agentId: first.agentId,
    trigger: "manual",
    sessionFile: resolveExtractionSessionFile(first.agentId, runId),
    workspaceDir: resolveAgentWorkspaceDir(cfg, first.agentId),
    config: cfg,
    provider: modelRef.provider,
    model: modelRef.model,
    prompt: buildCommitmentExtractionPrompt({ cfg, items: params.items }),
    disableTools: true,
    thinkLevel: "off",
    verboseLevel: "off",
    reasoningLevel: "off",
    fastMode: true,
    timeoutMs: resolved.extraction.timeoutSeconds * 1000,
    runId,
    bootstrapContextMode: "lightweight",
    skillsSnapshot: { prompt: "", skills: [] },
    suppressToolErrorWarnings: true,
  });
  return parseCommitmentExtractionOutput(joinPayloadText(result));
}

async function hydrateBatch(
  batch: Array<Omit<CommitmentExtractionItem, "existingPending"> & { cfg?: OpenClawConfig }>,
): Promise<CommitmentExtractionItem[]> {
  return Promise.all(
    batch.map(async (item) =>
      hydrateCommitmentExtractionItem({
        cfg: item.cfg,
        item,
      }),
    ),
  );
}

export async function drainCommitmentExtractionQueue(): Promise<number> {
  if (draining) {
    return 0;
  }
  draining = true;
  try {
    let processed = 0;
    while (queue.length > 0) {
      const firstCfg = queue[0]?.cfg;
      const resolved = resolveCommitmentsConfig(firstCfg);
      const batch = queue.splice(0, resolved.extraction.batchMaxItems);
      const items = await hydrateBatch(batch);
      const extractor = runtime.extractBatch ?? defaultExtractBatch;
      let result: CommitmentExtractionBatchResult;
      try {
        result = await extractor({ cfg: firstCfg, items });
      } catch (error) {
        if (isTerminalExtractionError(error)) {
          openTerminalFailureCooldown(items[0]?.agentId ?? "", error);
        }
        throw error;
      }
      await persistCommitmentExtractionResult({
        cfg: firstCfg,
        items,
        result,
        nowMs: Date.now(),
      });
      processed += items.length;
    }
    return processed;
  } finally {
    draining = false;
  }
}
