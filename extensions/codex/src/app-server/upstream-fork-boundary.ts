import { isDeepStrictEqual } from "node:util";
import {
  readVisibleSessionTranscriptMessageEntries,
  type SessionTranscriptMessageEntry,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import { assertCodexThreadAcceptsDirectInput } from "./protocol-validators.js";
import type { CodexThread, CodexTurn } from "./protocol.js";
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
  /** Baseline for the forked thread: the last retained turn (null when the cut is
   * before the first turn), so the upstream monitor does not replay retained
   * history as fresh external activity. */
  lastRetainedTurnId: string | null;
};

export type CodexUpstreamForkBoundaryResult =
  | {
      ok: true;
      boundary: CodexUpstreamForkBoundary;
      editorText?: string;
      canonical?: {
        thread: CodexThread;
        turns: CodexTurn[];
        prefix: SessionTranscriptMessageEntry[];
        assertUnchanged: () => Promise<void>;
      };
    }
  | { ok: false; code: CodexUpstreamForkBoundaryFailureCode; message: string };

const TURN_PAGE_LIMIT = 100;

function failure(
  code: CodexUpstreamForkBoundaryFailureCode,
  message: string,
): CodexUpstreamForkBoundaryResult {
  return { ok: false, code, message };
}

function textOnlyMessage(content: unknown): string | undefined {
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
      const nativeText = textOnlyMessage(item.content);
      if (nativeText === undefined) {
        return failure(
          "drift-mismatch",
          "A message before the fork point contains images or attachments that cannot be verified across OpenClaw and Codex. Fork from a text-only span instead.",
        );
      }
      const local = params.localPrefix[localIndex];
      const upstreamText = local && readUpstreamUserText(local.message);
      // Harness evidence binds the complete submitted text, not the trimmed/truncated
      // display projection that legacy imported mirrors retain.
      const text = upstreamText ? nativeText : projectCodexUserItemText(item);
      if (!text) {
        continue;
      }
      const identity = local && readMirrorIdentity(local.message);
      // Imports retain a bounded tail. Locate its recorded start, then verify every
      // retained user in order; repeated text must never choose an earlier native turn.
      const matchesIdentity =
        identity === `${turn.id}:${item.id}` || (!isSteer && identity === `${turn.id}:prompt`);
      if (!matchedPrefix && !matchesIdentity) {
        continue;
      }
      matchedPrefix = true;
      const localText = textOnlyMessage(
        local && "content" in local.message ? local.message.content : undefined,
      );
      // Harness prompts carry the sent text separately from the display text.
      // Its existing attestation must still bind both, or a local edit could pass drift checks.
      const upstreamPromptVerified =
        !upstreamText ||
        (local?.message.role === "user" &&
          readCodexMirrorSourceFingerprint(local.message) ===
            fingerprintCodexMirrorSourceMessage(local.message));
      if (
        !matchesIdentity ||
        !upstreamPromptVerified ||
        localText === undefined ||
        text !== (upstreamText ?? localText)
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
          lastRetainedTurnId: retained?.id ?? null,
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
  canonicalThreadId?: string;
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
    const target = visibleUserEntries[targetIndex]!;
    const isOriginal = (entry: SessionTranscriptMessageEntry) => {
      const identity = readMirrorIdentity(entry.message);
      return Boolean(
        identity &&
        "idempotencyKey" in entry.message &&
        entry.message.idempotencyKey ===
          `codex-app-server:${params.threadId}:history:${identity}` &&
        readCodexMirrorSourceFingerprint(entry.message),
      );
    };
    // Root S may no longer exist. Only original imported targets depend on S;
    // retained ancestor turn identities are verified against current canonical C.
    const canonical = Boolean(params.canonicalThreadId && !isOriginal(target));
    const threadId = canonical ? params.canonicalThreadId! : params.threadId;
    const thread = await params.control.readThread(threadId, false);
    if (thread.id !== threadId) {
      return failure(
        "upstream-unavailable",
        "This Codex thread is unavailable or its identity changed.",
      );
    }
    assertCodexThreadAcceptsDirectInput(thread);
    if (thread.status?.type === "active") {
      return failure(
        "in-progress-turn",
        "This Codex thread is active. Wait for it to finish before forking.",
      );
    }
    const localPrefix = visibleUserEntries.slice(0, targetIndex + 1).filter((entry) => {
      if (!canonical) {
        return true;
      }
      if (isOriginal(entry)) {
        return false;
      }
      const meta = "__openclaw" in entry.message ? entry.message["__openclaw"] : undefined;
      const blocked = isRecord(meta) ? meta.beforeAgentRunBlocked : undefined;
      return !(
        entry !== target &&
        isRecord(blocked) &&
        typeof blocked.blockedBy === "string" &&
        typeof blocked.blockedAt === "number"
      );
    });
    const turns = await listCodexUpstreamTurns(params.control, threadId);
    const resolved = resolveCodexUpstreamForkBoundaryFromTurns({
      turns,
      localPrefix,
    });
    const selected = canonical ? entries.slice(0, entries.indexOf(target) + 1) : [];
    const displayPrefix = selected.slice(0, -1);
    if (
      canonical &&
      (displayPrefix.length > 200 || Buffer.byteLength(JSON.stringify(displayPrefix)) > 512 * 1024)
    ) {
      return failure(
        "upstream-unavailable",
        "The local display prefix exceeds the safe fork-copy limit. Use native Codex to fork this conversation.",
      );
    }
    const frozen = structuredClone(selected);
    const prefix = frozen.slice(0, -1);
    return resolved.ok
      ? {
          ...resolved,
          editorText: textOnlyMessage(
            "content" in target.message ? target.message.content : undefined,
          ),
          ...(canonical
            ? {
                canonical: {
                  thread,
                  turns,
                  prefix,
                  assertUnchanged: async () => {
                    const current = await readVisibleSessionTranscriptMessageEntries(params);
                    const index = current.findIndex((entry) => entry.entryId === params.entryId);
                    if (index < 0 || !isDeepStrictEqual(current.slice(0, index + 1), frozen)) {
                      throw new Error("The local Codex fork prefix changed during initialization");
                    }
                    const currentThread = await params.control.readThread(threadId, false);
                    assertCodexThreadAcceptsDirectInput(currentThread);
                    if (
                      currentThread.id !== thread.id ||
                      currentThread.path !== thread.path ||
                      currentThread.cwd !== thread.cwd ||
                      currentThread.historyMode !== thread.historyMode ||
                      currentThread.status?.type === "active"
                    ) {
                      throw new Error("The canonical Codex source changed during initialization");
                    }
                    const currentTurns = await listCodexUpstreamTurns(params.control, threadId);
                    const cut = turns.findIndex(
                      (turn) => turn.id === resolved.boundary.beforeTurnId,
                    );
                    if (
                      !isDeepStrictEqual(currentTurns.slice(0, cut + 1), turns.slice(0, cut + 1))
                    ) {
                      throw new Error(
                        "The canonical Codex fork boundary changed during initialization",
                      );
                    }
                  },
                },
              }
            : {}),
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
  const target = params.turns.find((turn) => turn.id === params.boundary.beforeTurnId);
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
