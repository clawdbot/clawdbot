import type { WorkboardCard } from "@openclaw/workboard-contract";
import { isCronSessionKey } from "openclaw/plugin-sdk/routing";
import type { OpenClawPluginApi, OpenClawPluginService } from "../api.js";
import { cardBoardId } from "./store-card-helpers.js";
import { MAX_CARDS } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_AUTOMATION_NUDGE_DEBOUNCE_MS = 60_000;

type WorkboardAutomationNudgeInput = {
  cards: readonly WorkboardCard[];
  sessionKey?: string;
};

type WorkboardAutomationNudgeService = OpenClawPluginService & {
  nudge: (input: WorkboardAutomationNudgeInput) => Promise<void>;
};

type PendingBoardNudge = {
  timer?: ReturnType<typeof setTimeout>;
};

function isCronOriginSession(sessionKey: string | undefined): boolean {
  const normalized = sessionKey?.trim();
  // Cron keys are raw `cron:*` before store canonicalization and agent-scoped
  // `agent:*:cron:*:run:*` afterward; accepting either here would self-trigger.
  return normalized?.startsWith("cron:") === true || isCronSessionKey(normalized);
}

export function createWorkboardAutomationNudgeService(params: {
  store: WorkboardStore;
  gateway: Pick<OpenClawPluginApi["runtime"]["gateway"], "request">;
}): WorkboardAutomationNudgeService {
  let generation = 0;
  let logger: Parameters<OpenClawPluginService["start"]>[0]["logger"] | undefined;
  const pendingByBoard = new Map<string, PendingBoardNudge>();

  const nudgeBoard = async (boardId: string, jobId: string, owner: number) => {
    if (generation !== owner || !logger || pendingByBoard.has(boardId)) {
      return;
    }
    if (pendingByBoard.size >= MAX_CARDS) {
      logger?.warn(`workboard automation nudge skipped for board ${boardId}: debounce map full`);
      return;
    }
    const pending: PendingBoardNudge = {};
    const expiresAt = Date.now() + WORKBOARD_AUTOMATION_NUDGE_DEBOUNCE_MS;
    // The board entry owns both the in-flight request and its cooldown, so a
    // second lifecycle event can never overlap the first automation run request.
    pendingByBoard.set(boardId, pending);
    try {
      await params.gateway.request(
        "cron.run",
        { id: jobId, mode: "force" },
        { scopes: ["operator.admin"] },
      );
    } catch (error) {
      // The automation schedule is the backstop; a nudge failure must not alter
      // lifecycle synchronization or card state.
      logger?.warn(`workboard automation nudge failed for board ${boardId}: ${String(error)}`);
    } finally {
      if (generation === owner && pendingByBoard.get(boardId) === pending) {
        pending.timer = setTimeout(
          () => {
            if (pendingByBoard.get(boardId) === pending) {
              pendingByBoard.delete(boardId);
            }
          },
          Math.max(0, expiresAt - Date.now()),
        );
        pending.timer.unref?.();
      }
    }
  };

  return {
    id: "workboard-automation-nudge",
    start(ctx) {
      generation += 1;
      logger = ctx.logger;
    },
    stop() {
      generation += 1;
      logger = undefined;
      for (const pending of pendingByBoard.values()) {
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
      }
      pendingByBoard.clear();
    },
    async nudge(input) {
      const owner = generation;
      if (!logger || isCronOriginSession(input.sessionKey) || input.cards.length === 0) {
        return;
      }
      try {
        const automationByBoard = new Map(
          (await params.store.listBoards()).boards.flatMap((board) =>
            board.automationJobId ? [[board.id, board.automationJobId] as const] : [],
          ),
        );
        const boardIds = new Set(input.cards.map((card) => cardBoardId(card)));
        await Promise.all(
          [...boardIds].flatMap((boardId) => {
            const jobId = automationByBoard.get(boardId);
            return jobId ? [nudgeBoard(boardId, jobId, owner)] : [];
          }),
        );
      } catch (error) {
        logger?.warn(`workboard automation nudge failed: ${String(error)}`);
      }
    },
  };
}
