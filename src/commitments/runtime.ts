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

export type CommitmentExtractionEnqueueInput = CommitmentScope & {
  cfg?: OpenClawConfig;
  nowMs?: number;
  userText: string;
  assistantText?: string;
  sourceMessageId?: string;
  sourceRunId?: string;
};

export type CommitmentExtractionRuntime = {
  extractBatch?: (params: {
    cfg?: OpenClawConfig;
    items: CommitmentExtractionItem[];
  }) => Promise<CommitmentExtractionBatchResult>;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  forceInTests?: boolean;
};

const log = createSubsystemLogger("commitments");

let runtime: CommitmentExtractionRuntime = {};
let queue: Array<Omit<CommitmentExtractionItem, "existingPending"> & { cfg?: OpenClawConfig }> = [];
let timer: TimerHandle | null = null;
let draining = false;

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
  if (
    !resolved.enabled ||
    shouldDisableBackgroundExtractionForTests() ||
    !isUsefulText(input.userText) ||
    !isUsefulText(input.assistantText) ||
    !input.agentId.trim() ||
    !input.sessionKey.trim() ||
    !input.channel.trim()
  ) {
    return false;
  }
  const nowMs = input.nowMs ?? Date.now();
  queue.push({
    itemId: buildItemId(input, nowMs),
    nowMs,
    timezone: resolveCommitmentTimezone(input.cfg),
    agentId: input.agentId.trim(),
    sessionKey: input.sessionKey.trim(),
    channel: input.channel.trim(),
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
  const result = await runEmbeddedPiAgent({
    sessionId: runId,
    sessionKey: `agent:${first.agentId}:commitments:${runId}`,
    agentId: first.agentId,
    trigger: "manual",
    sessionFile: resolveExtractionSessionFile(first.agentId, runId),
    workspaceDir: resolveAgentWorkspaceDir(cfg, first.agentId),
    config: cfg,
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
      const result = await extractor({ cfg: firstCfg, items });
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
