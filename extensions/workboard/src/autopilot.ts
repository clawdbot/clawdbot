import type { WorkboardBoardSummary, WorkboardCard } from "@openclaw/workboard-contract";
import type { OpenClawPluginApi, OpenClawPluginService } from "../api.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { WorkboardStore } from "./store.js";
import {
  resolveAgentWorkboardWorkspaceRuntime,
  resolveWorkboardAgentWorkspace,
} from "./workspace-access.js";

const WORKBOARD_AUTOPILOT_DEBOUNCE_MS = 250;
const WORKBOARD_AUTOPILOT_RECONCILE_MS = 30_000;
const WORKBOARD_AUTOPILOT_FAILURE_BACKOFF_MS = 30_000;

type WorkboardAutopilotService = OpenClawPluginService & {
  reconcile: () => Promise<void>;
};
type WorkboardRuntimeConfig = Parameters<typeof resolveWorkboardAgentWorkspace>[0];

function currentRuntimeConfig(api: OpenClawPluginApi): WorkboardRuntimeConfig {
  // SAFETY: the immutable runtime snapshot has the same data shape; consumers only read it.
  return api.runtime.config.current() as WorkboardRuntimeConfig;
}

function isEligibleReadyCard(card: WorkboardCard): boolean {
  return (
    card.status === "ready" &&
    !card.metadata?.archivedAt &&
    !card.metadata?.claim &&
    Boolean(card.agentId?.trim())
  );
}

function isGuardedBoard(board: WorkboardBoardSummary): boolean {
  return !board.archivedAt && board.orchestration?.autopilotMode === "guarded";
}

export function createWorkboardAutopilotService(params: {
  api: OpenClawPluginApi;
  store: WorkboardStore;
  debounceMs?: number;
  reconcileMs?: number;
  failureBackoffMs?: number;
}): WorkboardAutopilotService {
  let logger: Parameters<OpenClawPluginService["start"]>[0]["logger"] | undefined;
  let unsubscribe: (() => void) | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let queued = false;
  const failureRetryAt = new Map<string, number>();
  const reportedFailure = new Map<string, string>();

  const schedule = () => {
    if (!logger) {
      return;
    }
    if (running) {
      queued = true;
      return;
    }
    if (debounceTimer) {
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void reconcile();
    }, params.debounceMs ?? WORKBOARD_AUTOPILOT_DEBOUNCE_MS);
    debounceTimer.unref?.();
  };

  const reconcileBoard = async (board: WorkboardBoardSummary) => {
    const now = Date.now();
    const skipCardIds = new Set(
      [...failureRetryAt].flatMap(([cardId, retryAt]) => (retryAt > now ? [cardId] : [])),
    );
    const config = currentRuntimeConfig(params.api);
    const result = await dispatchAndStartWorkboardCards({
      store: params.store,
      subagent: params.api.runtime.subagent,
      worktrees: params.api.runtime.worktrees,
      options: {
        boardId: board.id,
        maxStarts: 1,
        maxConcurrent: 1,
        requireAssigned: true,
        requireGuardedBoard: true,
        skipCardIds,
        materializeWorktree: true,
        resolveAgentWorkspace: (agentId) => resolveWorkboardAgentWorkspace(config, agentId),
        resolveAgentWorkspaceRuntime: (agentId, sessionKey, workspaceDir, provider, model) =>
          resolveAgentWorkboardWorkspaceRuntime({
            config,
            agentId,
            sessionKey,
            workspaceDir,
            modelProvider: provider,
            modelId: model,
            prepareSandboxWorkspaceAuthority: params.api.runtime.sandbox.prepareWorkspaceAuthority,
          }),
        // Guarded mode controls dispatch/review behavior. Filesystem confinement
        // remains opt-in per card through its persisted workspace authority.
        workspaceAccess: { unrestricted: true },
      },
    });
    for (const failure of result.startFailures) {
      failureRetryAt.set(
        failure.cardId,
        Date.now() + (params.failureBackoffMs ?? WORKBOARD_AUTOPILOT_FAILURE_BACKOFF_MS),
      );
      logger?.warn(
        `workboard guarded autopilot could not start ${failure.cardId}: ${failure.error}`,
      );
      if (reportedFailure.get(failure.cardId) !== failure.error) {
        reportedFailure.set(failure.cardId, failure.error);
        await params.store
          .addWorkerLog(failure.cardId, {
            level: "error",
            message: `Autopilot could not start: ${failure.error}`,
          })
          .catch(() => undefined);
      }
    }
    if (result.started[0]) {
      failureRetryAt.delete(result.started[0].cardId);
      reportedFailure.delete(result.started[0].cardId);
      logger?.info(
        `workboard guarded autopilot started ${result.started[0].cardId} on board ${board.id}`,
      );
    }
  };

  const reconcile = async () => {
    if (!logger || running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const [boardResult, cards] = await Promise.all([
        params.store.listBoards(),
        params.store.list(),
      ]);
      for (const cardId of failureRetryAt.keys()) {
        const card = cards.find((entry) => entry.id === cardId);
        if (!card || !isEligibleReadyCard(card)) {
          failureRetryAt.delete(cardId);
          reportedFailure.delete(cardId);
        }
      }
      for (const board of boardResult.boards.filter(isGuardedBoard)) {
        await reconcileBoard(board);
      }
    } catch (error) {
      logger?.warn(`workboard guarded autopilot reconciliation failed: ${String(error)}`);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        schedule();
      }
    }
  };

  return {
    id: "workboard-guarded-autopilot",
    start(ctx) {
      if (logger) {
        return;
      }
      logger = ctx.logger;
      unsubscribe = params.store.subscribeChanges(schedule);
      reconcileTimer = setInterval(
        () => void reconcile(),
        params.reconcileMs ?? WORKBOARD_AUTOPILOT_RECONCILE_MS,
      );
      reconcileTimer.unref?.();
      schedule();
    },
    stop() {
      logger = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = undefined;
      }
      queued = false;
      failureRetryAt.clear();
      reportedFailure.clear();
    },
    reconcile,
  };
}
