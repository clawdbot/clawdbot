import type { GatewaySessionRow } from "../../api/types.ts";
import { getWorkboardLifecycle } from "./lifecycle.ts";
import { taskSessionKeyMatchesCardSession } from "./task-links.ts";
import type {
  WorkboardCard,
  WorkboardHealthKey,
  WorkboardHealthSummary,
  WorkboardTaskSummary,
  WorkboardViewPresetId,
} from "./types.ts";

const WORKBOARD_RECENT_DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function workboardProofTotal(card: WorkboardCard): number {
  return Math.max(card.proofPage?.total ?? 0, card.metadata?.proof?.length ?? 0);
}

function hasWorkboardProofEvidence(card: WorkboardCard): boolean {
  return Boolean(
    workboardProofTotal(card) ||
    card.metadata?.artifacts?.length ||
    card.metadata?.attachments?.length,
  );
}

function taskFailedTerminal(task: WorkboardTaskSummary | undefined): boolean {
  return task?.status === "failed" || task?.status === "cancelled" || task?.status === "timed_out";
}

function taskFailureRepresentedByCard(
  card: WorkboardCard,
  task: WorkboardTaskSummary | undefined,
): boolean {
  if (!task || !taskFailedTerminal(task)) {
    return false;
  }
  const taskSessionKeys = [task.sessionKey, task.childSessionKey, task.ownerKey];
  return Boolean(
    card.metadata?.attempts?.some((attempt) => {
      if (
        attempt.status !== "failed" &&
        attempt.status !== "blocked" &&
        attempt.status !== "stopped"
      ) {
        return false;
      }
      if (task.runId && attempt.runId) {
        return attempt.runId === task.runId;
      }
      return Boolean(
        attempt.sessionKey &&
        taskSessionKeys.some((sessionKey) =>
          taskSessionKeyMatchesCardSession(sessionKey, attempt.sessionKey ?? ""),
        ),
      );
    }),
  );
}

function countCardFailedAttempts(card: WorkboardCard): number {
  if (card.metadata?.failureCount !== undefined) {
    return card.metadata.failureCount;
  }
  return (
    card.metadata?.attempts?.filter(
      (attempt) =>
        attempt.status === "failed" || attempt.status === "blocked" || attempt.status === "stopped",
    ).length ?? 0
  );
}

function cardRecentlyDone(card: WorkboardCard): boolean {
  if (card.status !== "done") {
    return false;
  }
  const doneAt = card.completedAt ?? card.updatedAt;
  return Date.now() - doneAt <= WORKBOARD_RECENT_DONE_WINDOW_MS;
}

export function summarizeWorkboardHealth(params: {
  cards: readonly WorkboardCard[];
  tasksByCardId: ReadonlyMap<string, WorkboardTaskSummary>;
  sessions: readonly GatewaySessionRow[];
}): WorkboardHealthSummary {
  const summary: WorkboardHealthSummary = {
    running: 0,
    blocked: 0,
    stale: 0,
    readyUnassigned: 0,
    missingProof: 0,
    failedAttempts: 0,
  };
  for (const card of params.cards) {
    const task = params.tasksByCardId.get(card.id);
    if (workboardCardMatchesHealthKey(card, "running", params.sessions, task)) {
      summary.running += 1;
    }
    if (workboardCardMatchesHealthKey(card, "blocked", params.sessions, task)) {
      summary.blocked += 1;
    }
    if (workboardCardMatchesHealthKey(card, "stale", params.sessions, task)) {
      summary.stale += 1;
    }
    if (workboardCardMatchesHealthKey(card, "readyUnassigned", params.sessions, task)) {
      summary.readyUnassigned += 1;
    }
    if (workboardCardMatchesHealthKey(card, "missingProof", params.sessions, task)) {
      summary.missingProof += 1;
    }
    summary.failedAttempts += countCardFailedAttempts(card);
    if (taskFailedTerminal(task) && !taskFailureRepresentedByCard(card, task)) {
      summary.failedAttempts += 1;
    }
  }
  return summary;
}

export function workboardCardMatchesHealthKey(
  card: WorkboardCard,
  key: WorkboardHealthKey,
  sessions: readonly GatewaySessionRow[],
  task?: WorkboardTaskSummary,
): boolean {
  const lifecycle = getWorkboardLifecycle(card, sessions, task);
  switch (key) {
    case "running":
      return card.status === "running" || lifecycle.state === "running";
    case "blocked":
      return card.status === "blocked";
    case "stale":
      return Boolean(card.metadata?.stale || lifecycle.state === "stale");
    case "readyUnassigned":
      return card.status === "ready" && !card.agentId?.trim() && !card.metadata?.claim;
    case "missingProof":
      return card.status === "done" && !hasWorkboardProofEvidence(card);
    case "failedAttempts":
      return countCardFailedAttempts(card) > 0 || taskFailedTerminal(task);
  }
  return false;
}

export function filterWorkboardCardsForPreset(params: {
  cards: readonly WorkboardCard[];
  preset: WorkboardViewPresetId;
  tasksByCardId: ReadonlyMap<string, WorkboardTaskSummary>;
  sessions: readonly GatewaySessionRow[];
  defaultAgentId?: string | null;
}): WorkboardCard[] {
  const defaultAgentId = params.defaultAgentId?.trim();
  return params.cards.filter((card) => {
    const task = params.tasksByCardId.get(card.id);
    const lifecycle = getWorkboardLifecycle(card, params.sessions, task);
    switch (params.preset) {
      case "all":
        return true;
      case "default_agent":
        return defaultAgentId
          ? card.agentId === defaultAgentId || !card.agentId?.trim()
          : !card.agentId;
      case "ready":
        return card.status === "ready";
      case "running":
        return card.status === "running" || lifecycle.state === "running";
      case "blocked":
        return card.status === "blocked";
      case "review":
        return card.status === "review";
      case "stale":
        return Boolean(card.metadata?.stale) || lifecycle.state === "stale";
      case "missing_proof":
        return card.status === "done" && !hasWorkboardProofEvidence(card);
      case "recently_done":
        return cardRecentlyDone(card);
    }
    return false;
  });
}
