// Workboard plugin module implements dispatcher behavior.
import path from "node:path";
import type {
  WorkboardCard,
  WorkboardExecution,
  WorkboardWorkspace,
} from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  isFutureDateTimestampMs,
  resolveNonNegativeIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { canonicalPathFromExistingAncestor } from "openclaw/plugin-sdk/security-runtime";
import {
  assertRestrictedWorkboardTarget,
  managedWorktreeName,
  resolveDispatchWorkspaceAccess,
  type ResolveAgentWorkspaceRuntime,
} from "./dispatcher-workspace.js";
import { cardBoardId } from "./store-card-helpers.js";
import { isWorkboardClaimReclaimable } from "./store-constants.js";
import { WorkboardStore, type WorkboardDispatchResult } from "./store.js";
import {
  assertCanonicalWorkboardRootAccess,
  assertWorkboardWorkspaceSourceAccess,
  WORKBOARD_REQUIRED_WORKER_TOOLS,
  type WorkboardWorkspaceAccess,
} from "./workspace-access.js";

const DEFAULT_DISPATCH_MAX_STARTS = 3;
const DEFAULT_DISPATCH_OWNER = "workboard-dispatcher";

export type WorkboardSubagentRuntime = Pick<PluginRuntime["subagent"], "run">;
export type WorkboardWorktreeRuntime = PluginRuntime["worktrees"];

type WorkboardDispatchStartOptions = {
  maxStarts?: number;
  model?: string;
  provider?: string;
  ownerId?: string;
  boardId?: string;
  now?: number;
  materializeWorktree?: boolean;
  resolveAgentWorkspace?: (agentId?: string) => string;
  resolveAgentWorkspaceRuntime?: ResolveAgentWorkspaceRuntime;
  workspaceAccess?: WorkboardWorkspaceAccess;
};

type WorkboardStartedRun = {
  cardId: string;
  title: string;
  sessionKey: string;
  runId: string;
};

type WorkboardStartFailure = {
  cardId: string;
  title: string;
  error: string;
};

type WorkboardDispatchAndStartResult = WorkboardDispatchResult & {
  started: WorkboardStartedRun[];
  startFailures: WorkboardStartFailure[];
};

type WorkboardDispatchStartParams = {
  store: WorkboardStore;
  subagent: WorkboardSubagentRuntime;
  worktrees?: WorkboardWorktreeRuntime;
  options?: WorkboardDispatchStartOptions;
};

const pendingWorkboardDispatches = new WeakMap<WorkboardStore, Promise<void>>();

function sanitizeSessionSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (sanitized || fallback).slice(0, 96);
}

function cardIsArchived(card: WorkboardCard): boolean {
  return Boolean(card.metadata?.archivedAt);
}

function cardHasActiveClaim(card: WorkboardCard, now: number): boolean {
  const claim = card.metadata?.claim;
  return Boolean(claim && isFutureDateTimestampMs(claim.expiresAt, { nowMs: now }));
}

function buildSessionKey(card: WorkboardCard): string {
  const boardId = sanitizeSessionSegment(cardBoardId(card), "default");
  const cardId = sanitizeSessionSegment(card.id, "card");
  const suffix = `subagent:workboard-${boardId}-${cardId}`;
  return card.agentId ? `agent:${sanitizeSessionSegment(card.agentId, "agent")}:${suffix}` : suffix;
}

function buildExecution(params: {
  card: WorkboardCard;
  sessionKey: string;
  runId: string;
  runtime: Awaited<ReturnType<WorkboardSubagentRuntime["run"]>>["runtime"];
  now: number;
}): WorkboardExecution {
  return {
    id: params.card.execution?.id ?? `${params.card.id}:agent-session`,
    kind: "agent-session",
    mode: "autonomous",
    status: "running",
    ...(params.runtime
      ? {
          engine: params.runtime.harness,
          model: `${params.runtime.provider}/${params.runtime.model}`,
        }
      : {}),
    sessionKey: params.sessionKey,
    runId: params.runId,
    startedAt: params.now,
    updatedAt: params.now,
  };
}

async function materializeWorkspace(params: {
  card: WorkboardCard;
  worktrees?: WorkboardWorktreeRuntime;
  materializeWorktree: boolean;
  workspaceAccess: WorkboardWorkspaceAccess;
}): Promise<{ workspace?: WorkboardWorkspace; cwd?: string }> {
  const workspace = params.card.metadata?.automation?.workspace;
  if (!workspace || workspace.kind === "scratch") {
    return {};
  }
  const sourcePath = workspace.sourcePath ?? workspace.path;
  const sourceBranch = workspace.sourcePath ? workspace.sourceBranch : workspace.branch;
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    throw new Error("worktree workspace path must be an absolute git checkout path");
  }
  // Persisted cards can outlive the caller that created them. Keep the exact
  // canonical path that passes this dispatcher's current boundary check.
  const canonicalSourcePath = await assertWorkboardWorkspaceSourceAccess(
    workspace,
    params.workspaceAccess,
  );
  if (!canonicalSourcePath) {
    throw new Error("worktree workspace path is required");
  }
  if (workspace.kind === "dir" || !params.workspaceAccess.unrestricted) {
    await assertCanonicalWorkboardRootAccess(canonicalSourcePath, params.workspaceAccess);
    return workspace.kind === "worktree"
      ? { cwd: canonicalSourcePath, workspace: { kind: "dir", path: canonicalSourcePath } }
      : { cwd: canonicalSourcePath };
  }
  if (!params.materializeWorktree) {
    throw new Error("managed worktree materialization was not explicitly authorized");
  }
  if (!params.worktrees) {
    throw new Error("managed worktree runtime is unavailable");
  }
  const worktree = await params.worktrees.create({
    repoRoot: canonicalSourcePath,
    name: managedWorktreeName(params.card.id),
    ...(sourceBranch ? { baseRef: sourceBranch } : {}),
    ownerKind: "workboard",
    ownerId: params.card.id,
  });
  let cwd: string;
  try {
    cwd = await canonicalPathFromExistingAncestor(worktree.path);
  } catch (error) {
    const removed = await params.worktrees
      .removeIfLossless({
        path: worktree.path,
        ownerKind: "workboard",
        ownerId: params.card.id,
      })
      .catch(() => false);
    if (!removed) {
      throw new Error(`${formatErrorMessage(error)}; managed worktree cleanup failed`, {
        cause: error,
      });
    }
    throw error;
  }
  return {
    cwd,
    workspace: {
      kind: "worktree",
      path: worktree.path,
      branch: worktree.branch,
      sourcePath,
      ...(sourceBranch ? { sourceBranch } : {}),
    },
  };
}

function buildWorkerPrompt(params: {
  card: WorkboardCard;
  context: string;
  ownerId: string;
  token: string;
}): string {
  return [
    `Work on this OpenClaw Workboard card: ${params.card.title}`,
    "",
    "## Worker protocol",
    `Card id: ${params.card.id}`,
    `Claim ownerId: ${params.ownerId}`,
    `Claim token: ${params.token}`,
    "",
    "Heartbeat with workboard_heartbeat using the card id and token while working.",
    "When done, call workboard_complete with the card id, token, summary, and proof.",
    "If you recorded proof separately, pass its returned proofId to workboard_complete.",
    "If blocked, call workboard_block with the card id, token, and reason.",
    "",
    params.context,
  ].join("\n");
}

function sortReadyCards(a: WorkboardCard, b: WorkboardCard): number {
  const priorityRank: Record<WorkboardCard["priority"], number> = {
    urgent: 0,
    high: 1,
    normal: 2,
    low: 3,
  };
  return (
    priorityRank[a.priority] - priorityRank[b.priority] ||
    a.position - b.position ||
    a.createdAt - b.createdAt
  );
}

function resolveDispatchOwner(card: WorkboardCard, now: number, ownerOverride?: string): string {
  return (
    ownerOverride ||
    (cardHasActiveClaim(card, now) ? card.metadata?.claim?.ownerId : undefined) ||
    card.agentId ||
    DEFAULT_DISPATCH_OWNER
  );
}

function selectStartableCards(
  cards: WorkboardCard[],
  limit: number,
  candidates: WorkboardCard[],
  ownerOverride: string | undefined,
  now: number,
): WorkboardCard[] {
  if (limit <= 0) {
    return [];
  }
  const runningByOwner = new Map<string, number>();
  for (const card of cards) {
    const claim = card.metadata?.claim;
    // Owner capacity is global but cleanup is board-scoped; retain the same
    // heartbeat grace as cleanup before a stale running card releases its slot.
    const consumesOwnerSlot =
      !isWorkboardClaimReclaimable(claim, now) &&
      (card.status === "running" ||
        (card.status !== "done" && cardHasActiveClaim(card, now)) ||
        card.execution?.status === "running");
    if (!consumesOwnerSlot || cardIsArchived(card)) {
      continue;
    }
    // A grace-protected running claim still occupies its actual worker, even
    // after the lease expires and the card's assigned agent differs.
    const owner = claim?.ownerId ?? resolveDispatchOwner(card, now);
    runningByOwner.set(owner, (runningByOwner.get(owner) ?? 0) + 1);
  }
  const selected: WorkboardCard[] = [];
  const fallback: WorkboardCard[] = [];
  const selectedOwners = new Set<string>();
  for (const card of candidates
    .filter(
      (entry) =>
        entry.status === "ready" && !cardHasActiveClaim(entry, now) && !cardIsArchived(entry),
    )
    .toSorted(sortReadyCards)) {
    const owner = resolveDispatchOwner(card, now, ownerOverride);
    if ((runningByOwner.get(owner) ?? 0) > 0) {
      continue;
    }
    if (selectedOwners.has(owner)) {
      fallback.push(card);
      continue;
    }
    selectedOwners.add(owner);
    selected.push(card);
  }
  // Try each owner before a failed owner's extra cards consume the outage budget.
  return [...selected, ...fallback];
}

export async function dispatchAndStartWorkboardCards(
  params: WorkboardDispatchStartParams,
): Promise<WorkboardDispatchAndStartResult> {
  const previous = pendingWorkboardDispatches.get(params.store);
  // Board filters must share their store's owner-capacity snapshot; otherwise
  // simultaneous passes can claim different cards for the same active worker.
  const dispatch = previous
    ? previous.then(() => runWorkboardDispatch(params))
    : runWorkboardDispatch(params);
  const settled = dispatch.then(
    () => undefined,
    () => undefined,
  );
  pendingWorkboardDispatches.set(params.store, settled);
  try {
    return await dispatch;
  } finally {
    if (pendingWorkboardDispatches.get(params.store) === settled) {
      pendingWorkboardDispatches.delete(params.store);
    }
  }
}

async function runWorkboardDispatch(
  params: WorkboardDispatchStartParams,
): Promise<WorkboardDispatchAndStartResult> {
  const now = params.options?.now ?? Date.now();
  const boardId = params.options?.boardId;
  const dispatch = await params.store.dispatch({ now, boardId });
  const maxStarts = resolveNonNegativeIntegerOption(
    params.options?.maxStarts,
    DEFAULT_DISPATCH_MAX_STARTS,
  );
  const started: WorkboardStartedRun[] = [];
  const startFailures: WorkboardStartFailure[] = [];
  const cards = await params.store.list();
  const candidates = await params.store.list({ boardId });
  const ownerOverride = params.options?.ownerId?.trim() || undefined;
  const startedOwners = new Set<string>();
  // Allow one fallback per worker slot without draining the queue during an outage.
  const maxAttempts = maxStarts * 2;
  let acceptedStarts = 0;
  let attemptedStarts = 0;

  for (const card of selectStartableCards(cards, maxStarts, candidates, ownerOverride, now)) {
    const ownerId = resolveDispatchOwner(card, now, ownerOverride);
    if (acceptedStarts >= maxStarts || attemptedStarts >= maxAttempts) {
      break;
    }
    if (startedOwners.has(ownerId)) {
      continue;
    }
    const sessionKey = buildSessionKey(card);
    let claimValue = "";
    let materializedWorkspace: WorkboardWorkspace | undefined;
    let implicitWorkspaceCwd: string | undefined;
    let runStarted = false;
    const requestedWorkspace = card.metadata?.automation?.workspace;
    let workspaceAccess: WorkboardWorkspaceAccess;
    let targetWorkspace: string | undefined;
    let persistWorkspaceAccess: boolean;
    try {
      ({ workspaceAccess, targetWorkspace, persistWorkspaceAccess } =
        await resolveDispatchWorkspaceAccess({
          card,
          currentAccess: params.options?.workspaceAccess,
          resolveAgentWorkspace: params.options?.resolveAgentWorkspace,
        }));
    } catch (error) {
      startFailures.push({
        cardId: card.id,
        title: card.title,
        error: formatErrorMessage(error),
      });
      continue;
    }
    if (!requestedWorkspace || requestedWorkspace.kind === "scratch") {
      if (!workspaceAccess.unrestricted) {
        if (!targetWorkspace) {
          startFailures.push({
            cardId: card.id,
            title: card.title,
            error: "target agent workspace is unavailable for restricted dispatch",
          });
          continue;
        }
        try {
          implicitWorkspaceCwd = targetWorkspace;
          await assertCanonicalWorkboardRootAccess(implicitWorkspaceCwd, workspaceAccess);
          await assertRestrictedWorkboardTarget({
            root: implicitWorkspaceCwd,
            agentId: card.agentId,
            sessionKey,
            modelProvider: params.options?.provider,
            modelId: params.options?.model,
            resolveAgentWorkspaceRuntime: params.options?.resolveAgentWorkspaceRuntime,
            worktrees: params.worktrees,
          });
        } catch (error) {
          startFailures.push({
            cardId: card.id,
            title: card.title,
            error: formatErrorMessage(error),
          });
          continue;
        }
      }
    } else {
      try {
        const canonicalSourcePath = await assertWorkboardWorkspaceSourceAccess(
          requestedWorkspace,
          workspaceAccess,
        );
        if (
          canonicalSourcePath &&
          requestedWorkspace.kind === "dir" &&
          workspaceAccess.unrestricted
        ) {
          await assertCanonicalWorkboardRootAccess(canonicalSourcePath, workspaceAccess);
        }
        if (canonicalSourcePath && !workspaceAccess.unrestricted) {
          await assertCanonicalWorkboardRootAccess(canonicalSourcePath, workspaceAccess);
          await assertRestrictedWorkboardTarget({
            root: canonicalSourcePath,
            agentId: card.agentId,
            sessionKey,
            modelProvider: params.options?.provider,
            modelId: params.options?.model,
            resolveAgentWorkspaceRuntime: params.options?.resolveAgentWorkspaceRuntime,
            worktrees: params.worktrees,
          });
        }
      } catch (error) {
        startFailures.push({
          cardId: card.id,
          title: card.title,
          error: formatErrorMessage(error),
        });
        continue;
      }
    }
    try {
      const claimed = await params.store.claim(
        card.id,
        { ownerId, ttlSeconds: card.metadata?.automation?.maxRuntimeSeconds },
        {
          expectedAuthority: {
            boardId: cardBoardId(card),
            status: card.status,
            agentId: card.agentId,
            workspace: card.metadata?.automation?.workspace,
            workspaceAccess: card.metadata?.automation?.workspaceAccess,
          },
          adoptWorkspaceAccess: persistWorkspaceAccess ? workspaceAccess : undefined,
        },
      );
      claimValue = claimed.token;
      // Racing card changes never reached a worker and must not consume the
      // provider-outage budget or starve a later healthy candidate.
      attemptedStarts += 1;
      const context = await params.store.buildWorkerContext(card.id);
      const materialized = await materializeWorkspace({
        card: claimed.card,
        worktrees: params.worktrees,
        materializeWorktree: params.options?.materializeWorktree === true,
        workspaceAccess,
      });
      const runCwd = materialized.cwd ?? implicitWorkspaceCwd;
      if (runCwd && !workspaceAccess.unrestricted) {
        await assertRestrictedWorkboardTarget({
          root: runCwd,
          // Claim may populate agentId; keep the sessionKey target identity.
          agentId: card.agentId,
          sessionKey,
          modelProvider: params.options?.provider,
          modelId: params.options?.model,
          resolveAgentWorkspaceRuntime: params.options?.resolveAgentWorkspaceRuntime,
          worktrees: params.worktrees,
        });
      }
      materializedWorkspace = materialized.workspace;
      if (materializedWorkspace) {
        await params.store.update(card.id, { workspace: materializedWorkspace, workspaceAccess });
      }
      const run = await params.subagent.run({
        sessionKey,
        message: buildWorkerPrompt({
          card: claimed.card,
          context,
          ownerId,
          token: claimValue,
        }),
        toolsAlsoAllow: [...WORKBOARD_REQUIRED_WORKER_TOOLS],
        ...(params.options?.provider ? { provider: params.options.provider } : {}),
        ...(params.options?.model ? { model: params.options.model } : {}),
        lane: `workboard:${cardBoardId(card)}:${card.id}`,
        idempotencyKey: `workboard:${card.id}:${claimed.card.updatedAt}`,
        lightContext: true,
        deliver: false,
        ...(runCwd ? { cwd: runCwd } : {}),
      });
      runStarted = true;
      acceptedStarts += 1;
      startedOwners.add(ownerId);
      const updated = await params.store.update(card.id, {
        sessionKey,
        runId: run.runId,
        execution: buildExecution({
          card: claimed.card,
          sessionKey,
          runId: run.runId,
          runtime: run.runtime,
          now,
        }),
        ...(materializedWorkspace ? { workspace: materializedWorkspace } : {}),
      });
      started.push({
        cardId: updated.id,
        title: updated.title,
        sessionKey,
        runId: run.runId,
      });
      // A worker already accepted this run. Logging must never revoke its
      // claim, block live execution, or reopen the owner's capacity slot.
      await params.store
        .addWorkerLog(
          updated.id,
          {
            level: "info",
            message: `Dispatcher started subagent run ${run.runId}.`,
            sessionKey,
            runId: run.runId,
          },
          { ownerId, token: claimValue },
        )
        .catch(() => undefined);
    } catch (error) {
      if (
        !runStarted &&
        materializedWorkspace?.kind === "worktree" &&
        materializedWorkspace.path &&
        params.worktrees
      ) {
        await params.worktrees
          .removeIfLossless({
            path: materializedWorkspace.path,
            ownerKind: "workboard",
            ownerId: card.id,
          })
          .catch(() => undefined);
        const sourceWorkspace = card.metadata?.automation?.workspace;
        if (sourceWorkspace) {
          await params.store.update(card.id, { workspace: sourceWorkspace }).catch(() => undefined);
        }
      }
      const message = formatErrorMessage(error);
      startFailures.push({ cardId: card.id, title: card.title, error: message });
      if (!claimValue || runStarted) {
        continue;
      }
      try {
        await params.store.block(
          card.id,
          {
            ownerId,
            token: claimValue,
            reason: `Dispatcher could not start worker: ${message}`,
          },
          { ownerId, token: claimValue },
        );
      } catch {
        // Leave the original start failure visible; dispatch will diagnose stale claims later.
      }
    }
  }

  return {
    ...dispatch,
    started,
    startFailures,
    count: dispatch.count + started.length + startFailures.length,
  };
}
