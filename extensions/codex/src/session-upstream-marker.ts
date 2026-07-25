import type { SessionCatalogContinueProviderResult } from "openclaw/plugin-sdk/session-catalog";
import type { CodexThread, CodexTurn } from "./app-server/protocol.js";

export type CodexUpstreamBaseline = {
  turnId: string | null;
  userMessageCount: number;
};

// Baseline must include an ACTIVE adoption-time turn: its already-present user
// items are history, and skipping back to the last terminal turn would replay
// them as external activity once that turn completes.
function lastIdentifiableTurn(
  thread: CodexThread,
  normalizeTurnId: (value: unknown) => string | undefined,
): CodexTurn | undefined {
  for (let index = (thread.turns?.length ?? 0) - 1; index >= 0; index -= 1) {
    const turn = thread.turns?.[index];
    const turnId = normalizeTurnId(turn?.id);
    if (turn && turnId) {
      return { ...turn, id: turnId };
    }
  }
  return undefined;
}

export function codexUpstreamBaseline(
  thread: CodexThread,
  normalizeTurnId: (value: unknown) => string | undefined,
): CodexUpstreamBaseline {
  const turn = lastIdentifiableTurn(thread, normalizeTurnId);
  return {
    turnId: turn?.id ?? null,
    userMessageCount: turn?.items.filter((item) => item.type === "userMessage").length ?? 0,
  };
}

// History import stops at the last terminal turn: mirroring a half-finished
// active turn would freeze partial content behind the covered-through id.
export function codexLastTerminalTurnId(
  thread: CodexThread,
  normalizeTurnId: (value: unknown) => string | undefined,
): string | undefined {
  for (let index = (thread.turns?.length ?? 0) - 1; index >= 0; index -= 1) {
    const turn = thread.turns?.[index];
    const turnId = normalizeTurnId(turn?.id);
    if (!turn || !turnId) {
      continue;
    }
    if (turn.status === "completed" || turn.status === "interrupted" || turn.status === "failed") {
      return turnId;
    }
  }
  return undefined;
}

/** Build the upstream link seed for a continued Codex session, if a baseline exists. */
export function codexUpstreamContinueResult(
  sessionKey: string,
  threadId: string,
  baseline: (CodexUpstreamBaseline & { connectionFingerprint: string }) | undefined,
): { sessionKey: string; upstream?: SessionCatalogContinueProviderResult["upstream"] } {
  if (!baseline) {
    return { sessionKey };
  }
  return {
    sessionKey,
    upstream: {
      kind: "codex-app-server",
      ref: { connectionFingerprint: baseline.connectionFingerprint, threadId },
      marker: { turnId: baseline.turnId, userMessageCount: baseline.userMessageCount },
    },
  };
}
