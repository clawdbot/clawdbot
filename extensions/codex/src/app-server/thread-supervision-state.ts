import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import type { CodexAppServerClient } from "./client.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexAppServerPendingSupervisionBranch,
  CodexAppServerThreadBinding,
} from "./session-binding.js";
import { CodexThreadBindingConflictError } from "./thread-lifecycle-errors.js";

export function matchesPendingSupervisionState(
  binding: CodexAppServerThreadBinding | undefined,
  expected: CodexAppServerPendingSupervisionBranch,
): boolean {
  const pending = binding?.pendingSupervisionBranch;
  const cleanupThreadIds = pending?.cleanupThreadIds ?? [];
  const expectedCleanupThreadIds = expected.cleanupThreadIds ?? [];
  return (
    binding?.threadId === expected.sourceThreadId &&
    binding.connectionScope === "supervision" &&
    binding.supervisionSourceThreadId === expected.sourceThreadId &&
    pending?.sourceThreadId === expected.sourceThreadId &&
    pending.connectionFingerprint === expected.connectionFingerprint &&
    pending.lastTurnId === expected.lastTurnId &&
    cleanupThreadIds.length === expectedCleanupThreadIds.length &&
    cleanupThreadIds.every((threadId, index) => threadId === expectedCleanupThreadIds[index])
  );
}

export function matchesMaterializedSupervisionBranch(
  binding: CodexAppServerThreadBinding | undefined,
  expected: {
    sourceThreadId: string;
    connectionFingerprint: string;
    threadId: string;
    model: string;
    modelProvider: string | undefined;
    historyCoveredThrough: string;
    agentWorkspaceDeveloperInstructions?: string;
    projectInstructionsUnavailableToGateway?: true;
    environmentSelectionFingerprint?: string;
  },
): boolean {
  return (
    binding?.threadId === expected.threadId &&
    binding.connectionScope === "supervision" &&
    binding.supervisionSourceThreadId === expected.sourceThreadId &&
    binding.appServerRuntimeFingerprint === expected.connectionFingerprint &&
    binding.pendingSupervisionBranch === undefined &&
    binding.model === expected.model &&
    binding.modelProvider === expected.modelProvider &&
    binding.historyCoveredThrough === expected.historyCoveredThrough &&
    binding.agentWorkspaceDeveloperInstructions === expected.agentWorkspaceDeveloperInstructions &&
    binding.projectInstructionsUnavailableToGateway ===
      expected.projectInstructionsUnavailableToGateway &&
    binding.environmentSelectionFingerprint === expected.environmentSelectionFingerprint
  );
}

export function requireDistinctSupervisionThreadId(params: {
  threadId: unknown;
  sourceThreadId: string;
  otherThreadId?: string;
  role: string;
}): string {
  let threadId: string;
  try {
    threadId = requireNonBlankSupervisionValue(params.threadId, `${params.role} thread id`);
  } catch (error) {
    throw new CodexAppServerUnsafeSubscriptionError(
      `Codex supervision ${params.role} may have materialized without a safe thread id`,
      { cause: error },
    );
  }
  if (threadId === params.sourceThreadId || threadId === params.otherThreadId) {
    throw new CodexAppServerUnsafeSubscriptionError(
      `Codex supervision ${params.role} reused an existing thread: ${threadId}`,
    );
  }
  return threadId;
}

export function readSupervisionResponseThreadId(value: unknown): unknown {
  const thread = isRecord(value) ? value.thread : undefined;
  return isRecord(thread) ? thread.id : undefined;
}

export async function recoverPendingSupervisionArtifacts(
  params: {
    client: CodexAppServerClient;
    bindingStore: CodexAppServerBindingStore;
    bindingIdentity: CodexAppServerBindingIdentity;
  },
  pending: CodexAppServerPendingSupervisionBranch,
): Promise<CodexAppServerPendingSupervisionBranch> {
  if (!pending.cleanupThreadIds?.length) {
    return pending;
  }
  const cleanup = await cleanPendingSupervisionArtifacts(params.client, pending);
  const next = withPendingSupervisionCleanup(pending, cleanup.remaining);
  if (cleanup.remaining.length > 0) {
    if (cleanup.remaining.length !== pending.cleanupThreadIds.length) {
      const updated = await params.bindingStore.mutate(params.bindingIdentity, {
        kind: "patch-pending-supervision-branch",
        expected: pending,
        pending: next,
      });
      if (!updated) {
        throw new CodexThreadBindingConflictError(
          pending.sourceThreadId,
          "recording supervised Codex cleanup recovery",
        );
      }
    }
    throw new Error(
      `Codex supervised branch cleanup must finish before retry: ${cleanup.remaining.join(", ")}`,
    );
  }
  const updated = await params.bindingStore.mutate(params.bindingIdentity, {
    kind: "patch-pending-supervision-branch",
    expected: pending,
    pending: next,
  });
  if (!updated) {
    throw new CodexThreadBindingConflictError(
      pending.sourceThreadId,
      "recovering a supervised Codex branch",
    );
  }
  return next;
}

export function withPendingSupervisionCleanup(
  pending: CodexAppServerPendingSupervisionBranch,
  cleanupThreadIds: string[],
): CodexAppServerPendingSupervisionBranch {
  return {
    sourceThreadId: pending.sourceThreadId,
    ...(pending.connectionFingerprint
      ? { connectionFingerprint: pending.connectionFingerprint }
      : {}),
    ...(pending.lastTurnId ? { lastTurnId: pending.lastTurnId } : {}),
    ...(cleanupThreadIds.length > 0 ? { cleanupThreadIds } : {}),
  };
}

export async function cleanPendingSupervisionArtifacts(
  client: CodexAppServerClient,
  pending: CodexAppServerPendingSupervisionBranch,
): Promise<{ remaining: string[] }> {
  const remaining: string[] = [];
  for (const threadId of pending.cleanupThreadIds ?? []) {
    if (!(await archiveSupervisionArtifact(client, threadId))) {
      remaining.push(threadId);
    }
  }
  return { remaining };
}

async function archiveSupervisionArtifact(
  client: CodexAppServerClient,
  threadId: string,
): Promise<boolean> {
  try {
    await client.request(
      "thread/archive",
      { threadId },
      { timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS },
    );
    return true;
  } catch (error) {
    const message = formatErrorMessage(error).toLowerCase();
    if (
      message.includes("no rollout found for thread id") ||
      message.includes("thread not found") ||
      message.includes("already archived")
    ) {
      return true;
    }
    await unsubscribeCodexThreadBestEffort(client, {
      threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
    embeddedAgentLog.warn("failed to archive temporary Codex supervision thread", {
      threadId,
      error,
    });
    return false;
  }
}

function requireNonBlankSupervisionValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Codex supervision ${label} is missing`);
  }
  return value.trim();
}
