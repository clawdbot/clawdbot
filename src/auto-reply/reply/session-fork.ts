import type { SessionEntry } from "../../config/sessions/types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

/**
 * Default max parent token count beyond which thread/session parent forking is skipped.
 * This prevents new thread sessions from inheriting near-full parent context.
 * See #26905.
 */
const DEFAULT_PARENT_FORK_MAX_TOKENS = 100_000;
const sessionForkRuntimeLoader = createLazyImportLoader(() => import("./session-fork.runtime.js"));

export type ParentForkDecision =
  | {
      status: "fork";
      maxTokens: number;
      parentTokens?: number;
    }
  | {
      status: "skip";
      reason: "parent-too-large";
      maxTokens: number;
      parentTokens: number;
      message: string;
    };

function loadSessionForkRuntime(): Promise<typeof import("./session-fork.runtime.js")> {
  return sessionForkRuntimeLoader.load();
}

function formatParentForkTooLargeMessage(params: {
  parentTokens: number;
  maxTokens: number;
}): string {
  return (
    `Parent context is too large to fork (${params.parentTokens}/${params.maxTokens} tokens); ` +
    "starting with isolated context instead."
  );
}

export async function resolveParentForkDecision(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<ParentForkDecision> {
  const maxTokens = DEFAULT_PARENT_FORK_MAX_TOKENS;
  const parentTokens = await resolveParentForkTokenCount({
    parentEntry: params.parentEntry,
    storePath: params.storePath,
  });
  if (typeof parentTokens === "number" && parentTokens > maxTokens) {
    return {
      status: "skip",
      reason: "parent-too-large",
      maxTokens,
      parentTokens,
      message: formatParentForkTooLargeMessage({ parentTokens, maxTokens }),
    };
  }
  return {
    status: "fork",
    maxTokens,
    ...(typeof parentTokens === "number" ? { parentTokens } : {}),
  };
}

export async function forkSessionFromParent(params: {
  parentEntry: SessionEntry;
  agentId: string;
  sessionsDir: string;
}): Promise<{ sessionId: string; sessionFile: string } | null> {
  const runtime = await loadSessionForkRuntime();
  return runtime.forkSessionFromParentRuntime(params);
}

async function resolveParentForkTokenCount(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<number | undefined> {
  const runtime = await loadSessionForkRuntime();
  return runtime.resolveParentForkTokenCountRuntime(params);
}
