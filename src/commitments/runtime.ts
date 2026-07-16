// Runs commitment extraction, scheduling, and follow-up lifecycle work.
import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
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

// Background runtime for extracting inferred follow-up commitments from
// completed turns. It batches hidden extraction requests and persists results.
type TimerHandle = ReturnType<typeof setTimeout>;
type ModelRef = { provider: string; model: string };
type EmbeddedAgentPayloadResult = { payloads?: Array<{ text?: string }> };

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

// Single-slot debounce: schedule one drain unless one is already pending. Shared
// by enqueue (new work), the overflow branch, and drain failure paths so queued
// work still progresses after a timer-fired extraction failure.
function scheduleDrainSoon(debounceMs: number): void {
  if (timer) {
    return;
  }
  timer = setTimer(() => {
    timer = null;
    void drainCommitmentExtractionQueue().catch((err: unknown) => {
      log.warn("commitment extraction failed", { error: String(err) });
    });
  }, debounceMs);
}

/** Installs runtime hooks for extraction tests or alternate batch extraction. */
function configureCommitmentExtractionRuntime(next: CommitmentExtractionRuntime): void {
  runtime = next;
}

/** Clears queued work, timers, and injected hooks for isolated tests. */
function resetCommitmentExtractionRuntimeForTests(): void {
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

/** Enqueues one completed turn for delayed commitment extraction. */
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
    // The queue can be full because a non-terminal failure restored its batch
    // (see drainCommitmentExtractionQueue). Dropping this request must not also
    // drop the retry: make sure a drain is scheduled before returning.
    scheduleDrainSoon(resolved.extraction.debounceMs);
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
  scheduleDrainSoon(resolved.extraction.debounceMs);
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

function openTerminalFailureCooldown(
  agentId: string,
  error: unknown,
  nowMs: number,
  fallbackNowMs: number,
): void {
  const cooldownUntil =
    resolveExpiresAtMsFromDurationMs(TERMINAL_EXTRACTION_FAILURE_COOLDOWN_MS, { nowMs }) ??
    resolveExpiresAtMsFromDurationMs(TERMINAL_EXTRACTION_FAILURE_COOLDOWN_MS, {
      nowMs: fallbackNowMs,
    });
  if (cooldownUntil !== undefined) {
    terminalFailureCooldownUntilByAgent.set(agentId, cooldownUntil);
  }
  // Terminal auth/model failures will keep failing for queued turns from the
  // same agent. Drop them and cool down to avoid noisy background retries.
  queue = queue.filter((item) => item.agentId !== agentId);
  log.warn("commitment extraction disabled temporarily after terminal model/auth failure", {
    agentId,
    cooldownMs: TERMINAL_EXTRACTION_FAILURE_COOLDOWN_MS,
    error: String(error),
  });
}

function joinPayloadText(result: EmbeddedAgentPayloadResult): string {
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
  const { runEmbeddedAgent } = await import("../agents/embedded-agent.js");
  const result = await runEmbeddedAgent({
    sessionId: runId,
    sessionKey: `agent:${first.agentId}:commitments:${runId}`,
    agentId: first.agentId,
    trigger: "manual",
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

function takeAgentBatch(
  agentId: string,
  maxItems: number,
): Array<Omit<CommitmentExtractionItem, "existingPending"> & { cfg?: OpenClawConfig }> {
  const batch = [];
  for (let index = 0; index < queue.length && batch.length < maxItems;) {
    if (queue[index]?.agentId !== agentId) {
      index += 1;
      continue;
    }
    const [item] = queue.splice(index, 1);
    if (item) {
      batch.push(item);
    }
  }
  return batch;
}

/** Drains queued extraction work in batches and returns processed item count. */
async function drainCommitmentExtractionQueue(): Promise<number> {
  if (draining) {
    return 0;
  }
  draining = true;
  try {
    let processed = 0;
    while (queue.length > 0) {
      const first = queue[0];
      if (!first) {
        break;
      }
      const firstCfg = first.cfg;
      const resolved = resolveCommitmentsConfig(firstCfg);
      // Extraction inherits the first item's model, credentials, workspace, and
      // session file. Keep every prompt and failure policy scoped to that agent.
      const batch = takeAgentBatch(first.agentId, resolved.extraction.batchMaxItems);
      const items = await hydrateBatch(batch);
      const extractor = runtime.extractBatch ?? defaultExtractBatch;
      let result: CommitmentExtractionBatchResult;
      try {
        result = await extractor({ cfg: firstCfg, items });
      } catch (error) {
        if (isTerminalExtractionError(error)) {
          openTerminalFailureCooldown(
            items[0]?.agentId ?? "",
            error,
            Date.now(),
            items[0]?.nowMs ?? Date.now(),
          );
          if (queue.length > 0) {
            scheduleDrainSoon(resolved.extraction.debounceMs);
          }
        } else {
          // Non-terminal failure (e.g. transient model/network error): the batch
          // was already spliced out, so restore it to the front in original order.
          // A timer-fired drain has already cleared `timer`, so also re-arm the
          // debounce; otherwise the restored batch sits only in memory and is lost
          // on process exit if no later enqueue happens to reschedule a drain.
          // Rethrow so the caller still logs; the next drain reprocesses it in order.
          queue.unshift(...batch);
          scheduleDrainSoon(resolved.extraction.debounceMs);
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

if (
  process.env.VITEST ||
  process.env.NODE_ENV === "test" ||
  process.env.OPENCLAW_COMMITMENTS_SAFETY_E2E === "1"
) {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.commitmentRuntimeTestApi")] = {
    configureCommitmentExtractionRuntime,
    drainCommitmentExtractionQueue,
    resetCommitmentExtractionRuntimeForTests,
  };
}
