import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import type { CodexThreadItem, CodexTurn } from "./protocol.js";

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
  text?: unknown;
  textElements?: unknown;
  url?: unknown;
  path?: unknown;
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

function userMessageDisplay(item: CodexThreadItem): {
  text: string;
  visible: boolean;
  hasUnverifiableInput: boolean;
} {
  let text = "";
  let hasTextElement = false;
  let hasImage = false;
  // Any non-text input (images, skills, mentions, future variants) has no canonical
  // cross-system identity; its presence makes the message unverifiable for drift checks.
  let hasUnverifiableInput = false;
  for (const input of asInputs(item)) {
    if (input.type === "text") {
      if (typeof input.text === "string") {
        text += input.text;
      }
      hasTextElement ||= Array.isArray(input.textElements) && input.textElements.length > 0;
    } else {
      hasUnverifiableInput = true;
      hasImage ||= input.type === "image" || input.type === "localImage";
    }
  }
  return {
    text,
    visible: Boolean(text.trim()) || hasTextElement || hasImage,
    hasUnverifiableInput,
  };
}

function isHiddenNestedReviewTurn(previous: CodexTurn | undefined, turn: CodexTurn): boolean {
  if (
    previous?.status !== "completed" ||
    turn.status !== "interrupted" ||
    turn.completedAt != null ||
    !previous.items.some((item) => item.type === "enteredReviewMode") ||
    !previous.items.some((item) => item.type === "exitedReviewMode")
  ) {
    return false;
  }
  const userMessages = turn.items.filter((item) => item.type === "userMessage");
  const [firstUserMessage, secondUserMessage] = userMessages;
  if (!firstUserMessage || !secondUserMessage || userMessages.length !== 2) {
    return false;
  }
  return JSON.stringify(asInputs(firstUserMessage)) === JSON.stringify(asInputs(secondUserMessage));
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
  return texts.join("");
}

function resolveCodexUpstreamForkBoundaryFromTurns(params: {
  turns: readonly CodexTurn[];
  userMessageOrdinal: number;
  /** Canonical text for every visible local user message through the target ordinal;
   * undefined marks content (images/attachments) whose identity cannot be verified. */
  localPrefixTexts: readonly (string | undefined)[];
}): CodexUpstreamForkBoundaryResult {
  let visibleUserMessagesSeen = 0;
  let reviewMode = false;
  for (const [turnIndex, turn] of params.turns.entries()) {
    const hiddenNestedReviewTurn = isHiddenNestedReviewTurn(params.turns[turnIndex - 1], turn);
    let userMessagesInTurn = 0;
    for (const item of turn.items) {
      if (item.type === "enteredReviewMode") {
        reviewMode = true;
        continue;
      }
      if (item.type === "exitedReviewMode") {
        reviewMode = false;
        continue;
      }
      if (item.type !== "userMessage") {
        continue;
      }
      const isSteer = userMessagesInTurn > 0;
      userMessagesInTurn += 1;
      if (reviewMode || hiddenNestedReviewTurn) {
        continue;
      }
      const display = userMessageDisplay(item);
      // Unverifiable inputs fail closed even when display-invisible: a skipped
      // skill/mention-only message would silently desync ordinals against the mirror.
      if (display.hasUnverifiableInput) {
        return failure(
          "drift-mismatch",
          "A message before the fork point contains images or attachments that cannot be verified across OpenClaw and Codex. Fork from a text-only span instead.",
        );
      }
      if (!display.visible) {
        continue;
      }
      const ordinal = visibleUserMessagesSeen;
      if (ordinal > params.userMessageOrdinal) {
        break;
      }
      // The local transcript is only a mirror; every prefix message must match, not just
      // the target — equal tails over different prefixes would bind divergent histories.
      const localText = params.localPrefixTexts[ordinal];
      if (localText === undefined) {
        return failure(
          "drift-mismatch",
          "A message before the fork point contains images or attachments that cannot be verified across OpenClaw and Codex. Fork from a text-only span instead.",
        );
      }
      if (display.text !== localText) {
        return failure(
          "drift-mismatch",
          "The local conversation no longer matches the Codex thread. Refresh the session and try again.",
        );
      }
      if (ordinal !== params.userMessageOrdinal) {
        visibleUserMessagesSeen += 1;
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
    "The message could not be matched to the Codex thread. Refresh the session and try again.",
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
    // Paginated-history threads reject itemsView "full" turn reads (thread/items/list
    // is required); fork support for them is future work — fail closed with intent.
    const thread = await params.control.readThread(params.threadId, false);
    if (thread.historyMode === "paginated") {
      return failure(
        "upstream-unavailable",
        "This Codex thread uses paginated history, which cannot be forked from OpenClaw yet.",
      );
    }
    const entries = await readVisibleSessionTranscriptMessageEntries({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    const visibleUserEntries = entries.filter((entry) => entry.role === "user");
    const userMessageOrdinal = visibleUserEntries.findIndex(
      (entry) => entry.entryId === params.entryId,
    );
    if (userMessageOrdinal < 0) {
      return failure(
        "drift-mismatch",
        "The local message could not be mapped to the Codex thread. Refresh the session and try again.",
      );
    }
    const localPrefixTexts = visibleUserEntries
      .slice(0, userMessageOrdinal + 1)
      .map((entry) =>
        localMessageText("content" in entry.message ? entry.message.content : undefined),
      );
    const turns = await listCodexUpstreamTurns(params.control, params.threadId);
    const resolved = resolveCodexUpstreamForkBoundaryFromTurns({
      turns,
      userMessageOrdinal,
      localPrefixTexts,
    });
    return resolved.ok
      ? { ...resolved, editorText: localPrefixTexts[userMessageOrdinal] }
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
