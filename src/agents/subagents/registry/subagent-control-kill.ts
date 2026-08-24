/** Authorized single-run, tree, and admin subagent kill orchestration. */
import { resolveSubagentLabel } from "../../../auto-reply/reply/subagents-utils.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import {
  killLatestSubagentRun,
  persistSubagentAbortedLastRun,
  resolveSubagentKillTargetState,
} from "./subagent-control-kill-runtime.js";
import {
  ensureSubagentControllerOwnsRun,
  getLatestOwnedSubagentRun,
  isCurrentSubagentRun,
  isSameSubagentRunGeneration,
  type ResolvedSubagentController,
} from "./subagent-control-scope.js";
import { resolveSessionEntryForKey } from "./subagent-list.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  listSubagentRunsForController,
} from "./subagent-registry-read.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

async function killSubagentRunTree(params: {
  cfg: OpenClawConfig;
  runs: Iterable<SubagentRunRecord>;
  cache: Map<string, Record<string, SessionEntry>>;
  seenChildSessionKeys: Set<string>;
  controllerSessionKey?: string;
  suppressTaskDelivery?: boolean;
}): Promise<{ killed: number; labels: string[]; errors: string[] }> {
  let killed = 0;
  const labels: string[] = [];
  const errors: string[] = [];

  for (const run of params.runs) {
    const childKey = run.childSessionKey?.trim();
    if (!childKey || params.seenChildSessionKeys.has(childKey)) {
      continue;
    }
    const latest = getLatestLiveSubagentRunByChildSessionKey(childKey);
    if (!latest || !isSameSubagentRunGeneration(latest, run)) {
      continue;
    }
    const latestControllerSessionKey =
      latest.controllerSessionKey?.trim() || latest.requesterSessionKey?.trim();
    if (params.controllerSessionKey && latestControllerSessionKey !== params.controllerSessionKey) {
      continue;
    }
    params.seenChildSessionKeys.add(childKey);
    const entry = latest;

    if (!entry.execution.endedAt || entry.pauseReason === "sessions_yield") {
      const stopped = await killLatestSubagentRun({
        cfg: params.cfg,
        entry,
        cache: params.cache,
        suppressTaskDelivery: params.suppressTaskDelivery,
      });
      const stopResult = stopped.result;
      if (stopResult.error) {
        errors.push(`${resolveSubagentLabel(stopped.entry)}: ${stopResult.error}`);
      }
      const stoppedEntryIsCurrent = isCurrentSubagentRun(stopped.entry, params.cfg);
      if (stopResult.superseded || (!stopResult.killed && !stoppedEntryIsCurrent)) {
        continue;
      }
      if (stopResult.killed) {
        killed += 1;
        labels.push(resolveSubagentLabel(stopped.entry));
      }
      // A replacement generation owns its own descendant tree. The old row's
      // kill may have committed, but it must not cascade through the shared key.
      if (!stoppedEntryIsCurrent) {
        continue;
      }
    }

    const cascade = await killSubagentRunTree({
      cfg: params.cfg,
      runs: listSubagentRunsForController(childKey),
      cache: params.cache,
      seenChildSessionKeys: params.seenChildSessionKeys,
      controllerSessionKey: childKey,
      suppressTaskDelivery: params.suppressTaskDelivery,
    });
    killed += cascade.killed;
    labels.push(...cascade.labels);
    errors.push(...cascade.errors);
  }

  return { killed, labels, errors };
}

async function cascadeKillChildren(params: {
  cfg: OpenClawConfig;
  parentChildSessionKey: string;
  cache: Map<string, Record<string, SessionEntry>>;
  seenChildSessionKeys?: Set<string>;
  suppressTaskDelivery?: boolean;
}): Promise<{ killed: number; labels: string[]; errors: string[] }> {
  return killSubagentRunTree({
    cfg: params.cfg,
    runs: listSubagentRunsForController(params.parentChildSessionKey),
    cache: params.cache,
    seenChildSessionKeys: params.seenChildSessionKeys ?? new Set<string>(),
    controllerSessionKey: params.parentChildSessionKey,
    suppressTaskDelivery: params.suppressTaskDelivery,
  });
}

/** Kills every currently controlled child run and its descendants. */
export async function killAllControlledSubagentRuns(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  runs: SubagentRunRecord[];
  suppressTaskDelivery?: boolean;
}) {
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
      killed: 0,
      labels: [],
    };
  }
  const result = await killSubagentRunTree({
    cfg: params.cfg,
    runs: params.runs,
    cache: new Map<string, Record<string, SessionEntry>>(),
    seenChildSessionKeys: new Set<string>(),
    controllerSessionKey: params.controller.controllerSessionKey,
    suppressTaskDelivery: params.suppressTaskDelivery,
  });
  if (result.errors.length > 0) {
    return {
      status: "error" as const,
      error: result.errors.join("; "),
      killed: result.killed,
      labels: result.labels,
    };
  }
  return { status: "ok" as const, killed: result.killed, labels: result.labels };
}

/** Kills one controlled subagent run and any active descendants. */
export async function killControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  suppressTaskDelivery?: boolean;
}) {
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  const currentEntry = getLatestLiveSubagentRunByChildSessionKey(params.entry.childSessionKey);
  if (!currentEntry || !isSameSubagentRunGeneration(currentEntry, params.entry)) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const ownershipError = ensureSubagentControllerOwnsRun({
    cfg: params.cfg,
    controller: params.controller,
    entry: currentEntry,
  });
  if (ownershipError) {
    return {
      status: "forbidden" as const,
      runId: currentEntry.runId,
      sessionKey: currentEntry.childSessionKey,
      error: ownershipError,
    };
  }
  const killCache = new Map<string, Record<string, SessionEntry>>();
  const stopped = await killLatestSubagentRun({
    cfg: params.cfg,
    entry: currentEntry,
    cache: killCache,
    suppressTaskDelivery: params.suppressTaskDelivery,
  });
  const stopResult = stopped.result;
  if (stopResult.error) {
    return {
      status: "error" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: stopResult.error,
    };
  }
  const stoppedEntryIsCurrent = isCurrentSubagentRun(stopped.entry, params.cfg);
  if (stopResult.superseded || (!stopResult.killed && !stoppedEntryIsCurrent)) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  if (!stoppedEntryIsCurrent) {
    return {
      status: "ok" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      killed: true as const,
      cascadeKilled: 0,
      cascadeLabels: undefined,
      text: `killed ${resolveSubagentLabel(params.entry)}.`,
    };
  }
  const seenChildSessionKeys = new Set<string>();
  const targetChildKey = params.entry.childSessionKey?.trim();
  if (targetChildKey) {
    seenChildSessionKeys.add(targetChildKey);
  }
  const cascade = await cascadeKillChildren({
    cfg: params.cfg,
    parentChildSessionKey: params.entry.childSessionKey,
    cache: killCache,
    seenChildSessionKeys,
    suppressTaskDelivery: params.suppressTaskDelivery,
  });
  if (cascade.errors.length > 0) {
    return {
      status: "error" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: cascade.errors.join("; "),
      ...(stopResult.killed ? { killed: true as const } : {}),
      cascadeKilled: cascade.killed,
      cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
    };
  }
  if (!stopResult.killed && cascade.killed === 0) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const cascadeText =
    cascade.killed > 0 ? ` (+ ${cascade.killed} descendant${cascade.killed === 1 ? "" : "s"})` : "";
  return {
    status: "ok" as const,
    runId: params.entry.runId,
    sessionKey: params.entry.childSessionKey,
    label: resolveSubagentLabel(params.entry),
    ...(stopResult.killed ? { killed: true as const } : {}),
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
    text: stopResult.killed
      ? `killed ${resolveSubagentLabel(params.entry)}${cascadeText}.`
      : `killed ${cascade.killed} descendant${cascade.killed === 1 ? "" : "s"} of ${resolveSubagentLabel(params.entry)}.`,
  };
}

/** Admin kill path for a subagent session key, bypassing caller ownership checks. */
export async function killSubagentRunAdmin(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}) {
  const targetSessionKey = params.sessionKey.trim();
  if (!targetSessionKey) {
    return { found: false as const, killed: false };
  }
  const entry = getLatestOwnedSubagentRun(targetSessionKey, params.agentId, params.cfg);
  if (!entry) {
    return { found: false as const, killed: false };
  }

  const killCache = new Map<string, Record<string, SessionEntry>>();
  const stopped = await killLatestSubagentRun({
    cfg: params.cfg,
    entry,
    cache: killCache,
  });
  const stopResult = stopped.result;
  if (stopResult.error) {
    return {
      found: true as const,
      killed: false,
      runId: stopped.entry.runId,
      sessionKey: stopped.entry.childSessionKey,
      cascadeKilled: 0,
      error: stopResult.error,
    };
  }
  const stoppedEntryIsCurrent = isCurrentSubagentRun(stopped.entry, params.cfg);
  if (stopResult.superseded || (!stopResult.killed && !stoppedEntryIsCurrent)) {
    return {
      found: true as const,
      killed: false,
      runId: stopped.entry.runId,
      sessionKey: stopped.entry.childSessionKey,
      cascadeKilled: 0,
    };
  }
  if (!stoppedEntryIsCurrent) {
    return {
      found: true as const,
      killed: stopResult.killed,
      ...(stopResult.targetState ? { targetState: stopResult.targetState } : {}),
      runId: stopped.entry.runId,
      sessionKey: stopped.entry.childSessionKey,
      cascadeKilled: 0,
    };
  }
  const seenChildSessionKeys = new Set<string>([targetSessionKey]);
  const cascade = await cascadeKillChildren({
    cfg: params.cfg,
    parentChildSessionKey: targetSessionKey,
    cache: killCache,
    seenChildSessionKeys,
  });
  // Descendant cleanup can yield long enough for the target run to finish.
  // Return the freshest registry state so task cancellation cannot make a stale kill sticky.
  const targetState = resolveSubagentKillTargetState(stopped.entry) ?? stopResult.targetState;
  const killedTarget =
    targetState?.state === "terminal" &&
    targetState.task.status === "cancelled" &&
    targetState.task.error === SUBAGENT_KILL_TASK_ERROR;
  const stopResultAlreadyClearedAbort =
    stopResult.targetState !== undefined &&
    !(
      stopResult.targetState.state === "terminal" &&
      stopResult.targetState.task.status === "cancelled" &&
      stopResult.targetState.task.error === SUBAGENT_KILL_TASK_ERROR
    );
  if (targetState && !killedTarget && !stopResultAlreadyClearedAbort) {
    const resolved = resolveSessionEntryForKey({
      cfg: params.cfg,
      key: targetSessionKey,
      cache: killCache,
    });
    await persistSubagentAbortedLastRun({
      childSessionKey: targetSessionKey,
      storePath: resolved.storePath,
      hasSessionEntry: resolved.entry !== undefined,
      expectedSessionId: resolved.entry?.sessionId,
      expectedLifecycleRevision: resolved.entry?.lifecycleRevision,
      abortedLastRun: false,
      isCurrent: () => isCurrentSubagentRun(stopped.entry, params.cfg),
    });
  }

  return {
    found: true as const,
    killed: stopResult.killed || cascade.killed > 0,
    ...(targetState ? { targetState } : {}),
    runId: stopped.entry.runId,
    sessionKey: stopped.entry.childSessionKey,
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
  };
}
