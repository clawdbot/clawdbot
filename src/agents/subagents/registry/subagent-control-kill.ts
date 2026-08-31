/** Authorized tree and admin subagent kill orchestration. */
import { resolveSubagentLabel } from "../../../auto-reply/reply/subagents-utils.js";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import type {
  SubagentAdminKillResult,
  TaskRegistryControlRuntime,
} from "../../../tasks/task-registry-control.types.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import { holdQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  killSubagentRun,
  persistSubagentAbortedLastRun,
  resolveSubagentKillTargetState,
  resolveSubagentKillSession,
} from "./subagent-control-kill-runtime.js";
import {
  ensureSubagentControllerOwnsRun,
  getLatestOwnedSubagentRun,
  isCurrentSubagentRun,
  isSameSubagentRunGeneration,
  type ResolvedSubagentController,
} from "./subagent-control-scope.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { listSubagentRunsForController } from "./subagent-registry-read.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

type KillBinding = {
  entry: SubagentRunRecord;
  isCurrent: (entry: SubagentRunRecord) => boolean;
  ownsRun: () => boolean;
  canTraverse: () => boolean;
};

type KillTree = KillBinding & {
  bind: (entry: SubagentRunRecord) => KillBinding;
  successor: () => SubagentRunRecord | undefined;
  session?: ReturnType<typeof resolveSubagentKillSession>;
  children: KillTree[];
  errors: Set<string>;
  discoveryFailed: boolean;
  dispatchHold?: ReturnType<typeof holdQueuedSwarmRun>;
};

type KillSelection = {
  cfg: OpenClawConfig;
  runs: Iterable<SubagentRunRecord>;
  assertCurrent?: () => void;
  controller?: Pick<ResolvedSubagentController, "controllerSessionKey" | "controllerAgentId">;
};

type KillScope = {
  refresh: () => void;
  retarget: (tree: KillTree, successor: SubagentRunRecord) => boolean;
};

async function withSubagentKillScope<T>(
  params: KillSelection,
  run: (scope: KillScope, trees: KillTree[]) => Promise<T>,
  publish?: (result: T, trees: KillTree[]) => T,
): Promise<T> {
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const selected = new Set<string>();
  const releaseRetirements: Array<() => void> = [];
  const holds: Array<NonNullable<ReturnType<typeof holdQueuedSwarmRun>>> = [];
  const hold = (tree: KillTree) => {
    if (!tree.dispatchHold) {
      tree.dispatchHold = holdQueuedSwarmRun(tree.entry.schedulerSlotId ?? tree.entry.runId);
      if (tree.dispatchHold) {
        holds.push(tree.dispatchHold);
      }
    }
  };
  const select = (
    runs: Iterable<SubagentRunRecord>,
    trees: KillTree[],
    owner?: KillSelection["controller"],
    isParentCurrent?: () => boolean,
  ): void => {
    const controller = owner ? { ...owner } : undefined;
    for (const snapshot of runs) {
      const entry = getLatestOwnedSubagentRun(
        snapshot.childSessionKey,
        snapshot.requesterAgentId,
        params.cfg,
      );
      if (
        !entry ||
        !isSameSubagentRunGeneration(entry, snapshot) ||
        selected.has(entry.childSessionKey)
      ) {
        continue;
      }
      const ownerCurrent = (candidate: SubagentRunRecord) => {
        params.assertCurrent?.();
        return (
          isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
          isParentCurrent?.() !== false &&
          (!controller ||
            !ensureSubagentControllerOwnsRun({ cfg: params.cfg, controller, entry: candidate }))
        );
      };
      if (!ownerCurrent(entry) || !isCurrentSubagentRun(entry, params.cfg)) {
        continue;
      }
      selected.add(entry.childSessionKey);
      const errors = new Set<string>();
      let session: ReturnType<typeof resolveSubagentKillSession> | undefined;
      let ownsSessionIncarnation: () => boolean;
      try {
        session = resolveSubagentKillSession(params.cfg, entry.childSessionKey);
        const { storePath } = session;
        const sessionId = session.entry?.sessionId;
        const lifecycleRevision = session.entry?.lifecycleRevision;
        const present = session.entry !== undefined;
        // Recovery replaces run ownership, never the logical session selected by Stop.
        // Keep the original target and incarnation even across a receipt-matched rebind.
        const { childSessionKey } = entry;
        ownsSessionIncarnation = () => {
          const stored = loadExactSessionEntryReadOnly({
            storePath,
            sessionKey: childSessionKey,
            clone: false,
          })?.entry;
          return (
            (stored !== undefined) === present &&
            stored?.sessionId === sessionId &&
            stored?.lifecycleRevision === lifecycleRevision
          );
        };
      } catch (error) {
        errors.add(formatErrorMessage(error));
        ownsSessionIncarnation = () => false;
      }
      const { childSessionKey, requesterAgentId } = entry;
      const latest = () => getLatestOwnedSubagentRun(childSessionKey, requesterAgentId, params.cfg);
      const retirement = subagentRuns.captureRetirement(
        entry,
        (candidate) => latest() === candidate,
      );
      releaseRetirements.push(retirement.release);
      const bind = (current: SubagentRunRecord): KillBinding => {
        const { generation, createdAt } = retirement.observation;
        const ownsRun = () =>
          retirement.observation.entry === current &&
          current.generation === generation &&
          current.createdAt === createdAt &&
          isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
          (subagentRuns.get(current.runId) === current ||
            retirement.observation.state === "retired");
        const isCurrent = (candidate: SubagentRunRecord) =>
          retirement.observation.entry === candidate &&
          ownerCurrent(candidate) &&
          isCurrentSubagentRun(candidate, params.cfg) &&
          (candidate !== current || ownsRun()) &&
          ownsSessionIncarnation();
        const canTraverse = () => {
          if (!ownerCurrent(current) || !ownsRun()) {
            return false;
          }
          const replacement = latest();
          return (
            (replacement === current ||
              (retirement.observation.state === "retired" &&
                (!replacement || compareSubagentRunGeneration(replacement, current) < 0))) &&
            ownsSessionIncarnation()
          );
        };
        return { entry: current, isCurrent, ownsRun, canTraverse };
      };
      const tree: KillTree = {
        ...bind(entry),
        session,
        bind,
        successor: () => retirement.observation.entry,
        children: [],
        errors,
        discoveryFailed: errors.size > 0,
      };
      hold(tree);
      // Publish each captured hold before another candidate's authority read can throw.
      trees.push(tree);
    }
  };
  const refreshTree = (tree: KillTree) => {
    if (tree.discoveryFailed) {
      return;
    }
    try {
      if (!tree.canTraverse()) {
        return;
      }
      if (tree.isCurrent(tree.entry)) {
        hold(tree);
        const controller = {
          controllerSessionKey: tree.entry.childSessionKey,
          controllerAgentId: resolveSessionAgentId({
            config: params.cfg,
            sessionKey: tree.entry.childSessionKey,
          }),
        };
        // Retirement preserves captured work, not discovery beneath a missing ancestor.
        select(
          listSubagentRunsForController(controller.controllerSessionKey),
          tree.children,
          controller,
          () => tree.canTraverse(),
        );
      }
      tree.children.forEach(refreshTree);
    } catch (error) {
      tree.discoveryFailed = true;
      tree.errors.add(formatErrorMessage(error));
    }
  };
  try {
    const trees: KillTree[] = [];
    select(params.runs, trees, params.controller);
    const scope: KillScope = {
      refresh: () => trees.forEach(refreshTree),
      retarget(tree, successor) {
        const binding = tree.bind(successor);
        if (!binding.canTraverse()) {
          return false;
        }
        // The lexical observer follows only committed receipts, including retirement
        // before this visit. Retired bindings preserve captured work, never discovery.
        Object.assign(tree, binding);
        tree.dispatchHold = undefined;
        scope.refresh();
        return true;
      },
    };
    scope.refresh();
    const result = await run(scope, trees);
    return publish ? publish(result, trees) : result;
  } finally {
    holds.forEach((reservation) => reservation.release());
    releaseRetirements.forEach((release) => release());
  }
}

async function killLatestSubagentRun(params: {
  cfg: OpenClawConfig;
  tree: KillTree;
  scope: KillScope;
  suppressTaskDelivery?: boolean;
  beforeSessionKill?: () => boolean;
  expectedRunId?: string;
  expectedGeneration?: number;
  expectedOwnerKey?: string;
}): Promise<{
  entry: SubagentRunRecord;
  session?: ReturnType<typeof resolveSubagentKillSession>;
  result: Awaited<ReturnType<typeof killSubagentRun>>;
}> {
  const { tree, scope } = params;
  const matchesExpected = (entry: SubagentRunRecord) =>
    (params.expectedGeneration === undefined || entry.generation === params.expectedGeneration) &&
    (!params.expectedOwnerKey || entry.requesterSessionKey === params.expectedOwnerKey);
  for (let attempt = 0; ; attempt += 1) {
    const entry = tree.entry;
    const session = tree.session;
    if (!session) {
      return { entry, result: { killed: false } };
    }
    if (!matchesExpected(entry)) {
      return { entry, session, result: { killed: false, superseded: true } };
    }
    const result = tree.isCurrent(entry)
      ? await killSubagentRun({
          ...params,
          entry,
          session,
          isCurrent: (candidate) => tree.isCurrent(candidate) && matchesExpected(candidate),
          withdrawQueuedReservation: () => tree.dispatchHold?.withdraw(),
          refreshDescendants: scope.refresh,
        })
      : { killed: false, superseded: true };
    // A committed retirement ends mutation/discovery of this ancestor, but not
    // cancellation of its captured descendants. Refusals on a live row stay fenced.
    if (
      result.superseded &&
      !tree.isCurrent(entry) &&
      tree.canTraverse() &&
      matchesExpected(entry)
    ) {
      return {
        entry,
        session,
        result: { killed: false, targetState: resolveSubagentKillTargetState(entry) },
      };
    }
    if (!result.superseded) {
      return { entry, session, result };
    }
    const successor = tree.successor();
    if (!successor || successor === entry || params.expectedRunId) {
      return { entry, session, result };
    }
    if (attempt === 2) {
      return {
        entry,
        session,
        result: {
          killed: false,
          superseded: true,
          error: "Subagent changed generations repeatedly during kill; retry in a moment.",
        },
      };
    }
    if (!scope.retarget(tree, successor)) {
      return { entry, session, result };
    }
  }
}

function collectKillErrors(trees: KillTree[], unlabeledRoot?: KillTree) {
  let failed = 0;
  const errors: string[] = [];
  const collect = (tree: KillTree) => {
    if (tree.errors.size > 0) {
      failed += 1;
      for (const error of tree.errors) {
        errors.push(
          tree === unlabeledRoot ? error : `${resolveSubagentLabel(tree.entry)}: ${error}`,
        );
      }
    }
    tree.children.forEach(collect);
  };
  // No authority checks or I/O here: a later sibling can fault an already-visited node.
  // Failures count stable selected nodes, independent of recovery rekeys and killed counts.
  trees.forEach(collect);
  return { errors, failed };
}

type KillTraversal = {
  cfg: OpenClawConfig;
  scope: KillScope;
  suppressTaskDelivery?: boolean;
};

async function killSubagentDescendants(
  params: KillTraversal & { tree: KillTree },
): ReturnType<typeof killSubagentRunTree> {
  const { tree, scope } = params;
  if (!tree.canTraverse()) {
    return { killed: 0, labels: [] };
  }
  scope.refresh();
  // Exact admin constraints belong only to its selected root, not each descendant.
  return killSubagentRunTree({
    cfg: params.cfg,
    suppressTaskDelivery: params.suppressTaskDelivery,
    scope,
    trees: tree.children,
  });
}

async function killSubagentRunTree(
  params: KillTraversal & { trees: KillTree[] },
): Promise<{ killed: number; labels: string[] }> {
  let killed = 0;
  const labels: string[] = [];
  for (const tree of params.trees) {
    try {
      if (!tree.entry.execution.endedAt || tree.entry.pauseReason === "sessions_yield") {
        const stopped = await killLatestSubagentRun({ ...params, tree });
        if (stopped.result.error) {
          tree.errors.add(stopped.result.error);
        }
        if (stopped.result.killed) {
          killed += 1;
          labels.push(resolveSubagentLabel(stopped.entry));
        }
        if (stopped.result.superseded) {
          continue;
        }
      }
      // Resolve recovery before checking traversal; ended ancestors need the same fence.
      const cascade = await killSubagentDescendants({ ...params, tree });
      killed += cascade.killed;
      labels.push(...cascade.labels);
    } catch (error) {
      tree.errors.add(formatErrorMessage(error));
    }
  }
  return { killed, labels };
}

async function killSubagentRoot(params: Parameters<typeof killLatestSubagentRun>[0]) {
  let stopped: Awaited<ReturnType<typeof killLatestSubagentRun>> = {
    entry: params.tree.entry,
    result: { killed: false },
  };
  let cascade: Awaited<ReturnType<typeof killSubagentRunTree>> = { killed: 0, labels: [] };
  try {
    // Root calls also reconcile finished tasks; the bulk walker skips that work.
    stopped = await killLatestSubagentRun(params);
    if (stopped.result.error) {
      params.tree.errors.add(stopped.result.error);
    }
    if (!stopped.result.superseded && !stopped.result.declined) {
      cascade = await killSubagentDescendants(params);
    }
  } catch (error) {
    params.tree.errors.add(formatErrorMessage(error));
  }
  return { ...stopped, cascade };
}

/** Kills every currently controlled child run and its descendants. */
export async function killAllControlledSubagentRuns(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  runs: SubagentRunRecord[];
  suppressTaskDelivery?: boolean;
  /** False declines traversal; the scope still releases every reservation hold. */
  beforeKill?: () => boolean | Promise<boolean>;
}) {
  if (params.controller.controlScope !== "children") {
    await params.beforeKill?.();
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
      killed: 0,
      labels: [],
    };
  }
  const result = await withSubagentKillScope(params, async (scope, trees) => {
    const accepted = params.beforeKill ? await params.beforeKill() : true;
    if (accepted) {
      scope.refresh();
    }
    const acceptedTrees = accepted ? trees : [];
    // The bulk signal was consumed above; never forward caller hooks into child kills.
    const stopped = await killSubagentRunTree({
      cfg: params.cfg,
      suppressTaskDelivery: params.suppressTaskDelivery,
      trees: acceptedTrees,
      scope,
    });
    return { ...stopped, ...collectKillErrors(acceptedTrees) };
  });
  if (result.errors.length > 0) {
    return {
      status: "error" as const,
      error: result.errors.join("; "),
      failed: result.failed,
      killed: result.killed,
      labels: result.labels,
    };
  }
  return { status: "ok" as const, killed: result.killed, labels: result.labels };
}

/** Admin kill path for a subagent session key, bypassing caller ownership checks. */
export async function killSubagentRunAdmin(
  params: Parameters<TaskRegistryControlRuntime["killSubagentRunAdmin"]>[0],
  control?: { assertCurrent: () => void; beforeSessionKill?: () => boolean },
): Promise<SubagentAdminKillResult> {
  const publish = (result: SubagentAdminKillResult): SubagentAdminKillResult => {
    if (params.onResult?.(result) !== undefined) {
      throw new TypeError("Subagent cancellation publication must be synchronous.");
    }
    return result;
  };
  const targetSessionKey = params.sessionKey.trim();
  if (!targetSessionKey) {
    return publish({ found: false as const, killed: false as const });
  }
  const entry = getLatestOwnedSubagentRun(targetSessionKey, params.agentId, params.cfg);
  if (!entry) {
    return publish({ found: false as const, killed: false as const });
  }
  if (params.expectedRunId?.trim() && entry.runId !== params.expectedRunId.trim()) {
    return publish({ found: false as const, killed: false as const });
  }
  if (
    (params.expectedGeneration !== undefined && entry.generation !== params.expectedGeneration) ||
    (params.expectedOwnerKey?.trim() &&
      entry.requesterSessionKey !== params.expectedOwnerKey.trim())
  ) {
    return publish({ found: false as const, killed: false as const });
  }

  let rootStopSuperseded = false;
  return withSubagentKillScope<SubagentAdminKillResult>(
    { cfg: params.cfg, runs: [entry], assertCurrent: control?.assertCurrent },
    async (scope, [tree]) => {
      if (!tree) {
        return { found: false as const, killed: false as const };
      }
      const stopped = await killSubagentRoot({
        cfg: params.cfg,
        tree,
        scope,
        beforeSessionKill: control?.beforeSessionKill,
        expectedRunId: params.expectedRunId?.trim() || undefined,
        expectedGeneration: params.expectedGeneration,
        expectedOwnerKey: params.expectedOwnerKey?.trim() || undefined,
      });
      const { result: stopResult, cascade } = stopped;
      rootStopSuperseded = stopResult.superseded === true;
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
      const resolved = stopped.session;
      if (targetState && !killedTarget && !stopResultAlreadyClearedAbort && resolved) {
        await persistSubagentAbortedLastRun({
          childSessionKey: targetSessionKey,
          storePath: resolved.storePath,
          hasSessionEntry: resolved.entry !== undefined,
          expectedSessionId: resolved.entry?.sessionId,
          expectedLifecycleRevision: resolved.entry?.lifecycleRevision,
          abortedLastRun: false,
          isCurrent: () => tree.isCurrent(stopped.entry),
        });
      }

      return {
        found: true as const,
        killed: stopResult.killed || cascade.killed > 0,
        runId: stopped.entry.runId,
        sessionKey: stopped.entry.childSessionKey,
        cascadeKilled: cascade.killed,
        cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
      };
    },
    (result, [tree]) => {
      if (!result.found || !tree) {
        return publish(result);
      }
      // Completion can commit during the awaited handoff. Fence both the retained
      // run and its session incarnation before any synchronous result publication.
      const ownsOutcome = !rootStopSuperseded && tree.ownsRun() && tree.canTraverse();
      if (!ownsOutcome) {
        tree.errors.add("Subagent ownership changed during cancellation; retry.");
      }
      const targetState = ownsOutcome ? resolveSubagentKillTargetState(tree.entry) : undefined;
      const { errors } = collectKillErrors([tree], tree);
      return publish({
        ...result,
        ...(targetState ? { targetState } : {}),
        ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      });
    },
  );
}
