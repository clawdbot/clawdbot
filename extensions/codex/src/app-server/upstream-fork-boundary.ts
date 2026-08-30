import {
  readVisibleSessionTranscriptMessageEntries,
  type SessionTranscriptMessageEntry,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import type { CodexThreadItem, CodexTurn } from "./protocol.js";
import { projectCodexUserItemText } from "./transcript-history-projection.js";
import {
  fingerprintCodexMirrorSourceMessage,
  readCodexMirrorSourceFingerprint,
} from "./transcript-mirror-attestation.js";
import { readMirrorIdentity, readUpstreamUserText } from "./upstream-prompt-provenance.js";

type CodexUpstreamForkBoundaryFailureCode =
  | "steer-message"
  | "in-progress-turn"
  | "drift-mismatch"
  | "upstream-unavailable";

type CodexUpstreamForkBoundary = {
  beforeTurnId: string;
  targetTurnId: string;
  /** Baseline for the forked thread: the last retained turn (null when the cut is
   * before the first turn), so the upstream monitor does not replay retained
   * history as fresh external activity. */
  retainedMarker: { turnId: string | null; userMessageCount: number };
};

type CodexUpstreamForkBoundaryResult =
  | { ok: true; boundary: CodexUpstreamForkBoundary; editorText?: string }
  | { ok: false; code: CodexUpstreamForkBoundaryFailureCode; message: string };

const TURN_PAGE_LIMIT = 100;

type UserInput = {
  type?: unknown;
};

function failure(
  code: CodexUpstreamForkBoundaryFailureCode,
  message: string,
): CodexUpstreamForkBoundaryResult {
  return { ok: false, code, message };
}

function asInputs(item: CodexThreadItem): UserInput[] {
  return Array.isArray(item.content) ? (item.content as UserInput[]) : [];
}

function localMessageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  // Non-text blocks (images/attachments) have no canonical cross-system identity;
  // undefined marks the message unverifiable so boundary resolution fails closed.
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return undefined;
    }
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string") {
      return undefined;
    }
    texts.push(typed.text);
  }
  return texts.join("\n");
}

function resolveCodexUpstreamForkBoundaryFromTurns(params: {
  turns: readonly CodexTurn[];
  localPrefix: readonly SessionTranscriptMessageEntry[];
}): CodexUpstreamForkBoundaryResult {
  let localIndex = 0;
  let matchedPrefix = false;
  for (const [turnIndex, turn] of params.turns.entries()) {
    let userMessagesInTurn = 0;
    for (const item of turn.items) {
      if (item.type !== "userMessage") {
        continue;
      }
      const isSteer = userMessagesInTurn > 0;
      userMessagesInTurn += 1;
      // Display placeholders are not evidence of attachment identity.
      if (asInputs(item).some((input) => input.type !== "text")) {
        return failure(
          "drift-mismatch",
          "A message before the fork point contains images or attachments that cannot be verified across OpenClaw and Codex. Fork from a text-only span instead.",
        );
      }
      const text = projectCodexUserItemText(item);
      if (!text) {
        continue;
      }
      const local = params.localPrefix[localIndex];
      const identity = local && readMirrorIdentity(local.message);
      // Imports retain a bounded tail. Locate its recorded start, then verify every
      // retained user in order; repeated text must never choose an earlier native turn.
      const matchesIdentity =
        identity === `${turn.id}:${item.id}` || (!isSteer && identity === `${turn.id}:prompt`);
      if (!matchedPrefix && !matchesIdentity) {
        continue;
      }
      matchedPrefix = true;
      const localText = localMessageText(
        local && "content" in local.message ? local.message.content : undefined,
      );
      const upstreamText = local && readUpstreamUserText(local.message);
      // Harness prompts carry the sent text separately from the display text.
      // Its existing attestation must still bind both, or a local edit could pass drift checks.
      const upstreamPromptVerified =
        !upstreamText ||
        (local?.message.role === "user" &&
          readCodexMirrorSourceFingerprint(local.message) ===
            fingerprintCodexMirrorSourceMessage(local.message));
      const expectedText = upstreamText
        ? projectCodexUserItemText({ content: [{ type: "text", text: upstreamText }] })
        : localText;
      if (
        !matchesIdentity ||
        !upstreamPromptVerified ||
        localText === undefined ||
        text !== expectedText
      ) {
        return failure(
          "drift-mismatch",
          "The local conversation no longer matches the Codex thread. Refresh the session and try again.",
        );
      }
      if (localIndex < params.localPrefix.length - 1) {
        localIndex += 1;
        continue;
      }
      if (isSteer) {
        return failure(
          "steer-message",
          "This message steered an existing Codex turn and cannot be forked independently. Fork from the turn's first message instead.",
        );
      }
      if (turn.status === "inProgress") {
        return failure(
          "in-progress-turn",
          "This Codex turn is still in progress. Wait for it to finish, then try forking again.",
        );
      }
      // beforeTurnId at the first turn yields a valid empty-history fork upstream
      // (codex-rs thread_fork_inner has no minimum-turn guard), matching the empty
      // local mirror prefix.
      const retained = turnIndex > 0 ? params.turns[turnIndex - 1] : undefined;
      return {
        ok: true,
        boundary: {
          beforeTurnId: turn.id,
          targetTurnId: turn.id,
          retainedMarker: retained
            ? {
                turnId: retained.id,
                userMessageCount: retained.items.filter(
                  (retainedItem) => retainedItem.type === "userMessage",
                ).length,
              }
            : { turnId: null, userMessageCount: 0 },
        },
      };
    }
  }
  return failure(
    "drift-mismatch",
    "The local history has no verified boundary in this Codex thread. Use native Codex to fork this conversation.",
  );
}

export async function listCodexUpstreamTurns(
  control: CodexSessionCatalogControl,
  threadId: string,
): Promise<CodexTurn[]> {
  const turns: CodexTurn[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    // Codex hydrates full turn items for both history modes; boundary validation
    // needs their recorded message identities, not the native storage layout.
    const page = await control.listTurnPage({
      threadId,
      limit: TURN_PAGE_LIMIT,
      sortDirection: "asc",
      itemsView: "full",
      ...(cursor ? { cursor } : {}),
    });
    turns.push(...page.data);
    const nextCursor = page.nextCursor?.trim() || undefined;
    if (!nextCursor) {
      return turns;
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("Codex returned a repeated thread/turns/list cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export async function resolveCodexUpstreamForkBoundary(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  entryId: string;
  threadId: string;
  control: CodexSessionCatalogControl;
}): Promise<CodexUpstreamForkBoundaryResult> {
  try {
    const entries = await readVisibleSessionTranscriptMessageEntries({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    const visibleUserEntries = entries.filter((entry) => entry.role === "user");
    const targetIndex = visibleUserEntries.findIndex((entry) => entry.entryId === params.entryId);
    if (targetIndex < 0) {
      return failure(
        "drift-mismatch",
        "The local message could not be mapped to the Codex thread. Refresh the session and try again.",
      );
    }
    const localPrefix = visibleUserEntries.slice(0, targetIndex + 1);
    const turns = await listCodexUpstreamTurns(params.control, params.threadId);
    const resolved = resolveCodexUpstreamForkBoundaryFromTurns({
      turns,
      localPrefix,
    });
    const target = localPrefix.at(-1)?.message;
    return resolved.ok
      ? {
          ...resolved,
          editorText: localMessageText(target && "content" in target ? target.content : undefined),
        }
      : resolved;
  } catch {
    return failure(
      "upstream-unavailable",
      "The Codex thread could not be read. Check that Codex is available, then try again.",
    );
  }
}

export function precheckCodexUpstreamForkBoundary(params: {
  boundary: CodexUpstreamForkBoundary;
  turns: readonly CodexTurn[];
}): CodexUpstreamForkBoundaryResult {
  const target = params.turns.find((turn) => turn.id === params.boundary.targetTurnId);
  if (!target) {
    return failure(
      "upstream-unavailable",
      "The Codex thread changed before it could be forked. Refresh the session and try again.",
    );
  }
  if (target.status === "inProgress") {
    return failure(
      "in-progress-turn",
      "This Codex turn is still in progress. Wait for it to finish, then try forking again.",
    );
  }
  return { ok: true, boundary: params.boundary };
}
