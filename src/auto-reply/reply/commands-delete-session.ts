import { resolveMainSessionKey } from "../../config/sessions.js";
import { resolveSessionStoreEntry } from "../../config/sessions/store-entry.js";
import { callGateway, isGatewayTransportError } from "../../gateway/call.js";
import { normalizeMainKey, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  createSessionWorkAdmissionHandoffForCurrent,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { rejectUnauthorizedCommand, requireGatewayClientScope } from "./command-gates.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

const DELETE_SESSION_COMMANDS = new Set(["/close", "/delete"]);

// sessions.delete responds only after the post-mutation worktree cleanup so it can
// report a preserved worktree honestly. That cleanup runs git operations that are
// individually time-bounded but can far outlast the admission drain window, so the
// RPC budget grants a bounded cleanup allowance on top of the drain contract.
const DELETE_SESSION_CLEANUP_ALLOWANCE_MS = 45_000;

export function parseDeleteSessionCommand(
  raw: string,
): { command: "/close" | "/delete"; tail: string } | null {
  const trimmed = raw.trim();
  const commandEnd = trimmed.search(/\s/);
  const commandToken = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  const normalized = commandToken.toLowerCase();
  if (!DELETE_SESSION_COMMANDS.has(normalized)) {
    return null;
  }
  return {
    command: normalized as "/close" | "/delete",
    tail: commandEnd === -1 ? "" : trimmed.slice(commandEnd).trim(),
  };
}

function deleteSessionReply(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

// Replies about a deleted (or possibly deleted) session must not be written to
// any transcript. When /close arrives through gateway chat.send, finalization
// would otherwise reload the now-missing entry, fall back to the deleted
// backing session id, and append the reply with createIfMissing, resurrecting
// an orphan transcript row immediately after deletion. That applies to the
// success replies and equally to the timeout-uncertainty reply: the RPC
// commits the deletion before the slow worktree cleanup, so an expired budget
// usually means the session is already gone. Marking the reply
// transcript-write-blocked keeps delivery live while telling finalization to
// skip that append.
function deleteSessionOutcomeReply(
  text: string,
  transcriptOwner: { sessionKey: string; agentId?: string; expectedSessionId?: string },
): CommandHandlerResult {
  const reply = setReplyPayloadMetadata(
    { text },
    {
      sourceReplyTranscriptMirror: {
        sessionKey: transcriptOwner.sessionKey,
        ...(transcriptOwner.agentId ? { agentId: transcriptOwner.agentId } : {}),
        ...(transcriptOwner.expectedSessionId
          ? { expectedSessionId: transcriptOwner.expectedSessionId }
          : {}),
        transcriptWriteBlocked: true,
      },
    },
  );
  return { shouldContinue: false, reply };
}

function isAgentMainSessionKey(params: HandleCommandsParams, sessionKey: string): boolean {
  const rest = parseAgentSessionKey(sessionKey)?.rest;
  return rest === "main" || rest === normalizeMainKey(params.cfg.session?.mainKey);
}

export const handleDeleteSessionCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseDeleteSessionCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, parsed.command);
  if (unauthorized) {
    return unauthorized;
  }
  const missingAdminScope = requireGatewayClientScope(params, {
    label: parsed.command,
    allowedScopes: ["operator.admin"],
    missingText: "You need operator.admin scope to delete sessions.",
  });
  if (missingAdminScope) {
    return missingAdminScope;
  }
  // Only authorized senders get usage feedback; unauthorized ones were rejected above
  // so a probing sender cannot distinguish this command from an unknown one.
  if (parsed.tail) {
    return deleteSessionReply(
      `${parsed.command} only deletes the current session and does not accept arguments.`,
    );
  }

  if (!params.storePath || !params.sessionKey) {
    return deleteSessionReply("Session deletion is not available for this session.");
  }
  if (
    params.sessionKey === resolveMainSessionKey(params.cfg) ||
    params.sessionKey === "global" ||
    isAgentMainSessionKey(params, params.sessionKey)
  ) {
    return deleteSessionReply("The main session cannot be deleted from chat. Use /reset instead.");
  }

  const store = params.sessionStore ?? {};
  const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
  const targetEntry = resolved.existing ?? params.sessionEntry;
  // A chat /close runs under the current turn's retained session-work admission.
  // Deleting the same session through the gateway RPC leaves this async context,
  // so without a handoff the server would treat the initiator's own admission as
  // competing work and block until it drains (which cannot happen until this RPC
  // returns). Hand the retained lease to the server so it adopts and exempts the
  // initiating admission. When no covering admission is active this is undefined
  // and the server falls back to the normal drain-and-retry contract.
  // The admission was registered under the RAW turn session key while the RPC
  // targets the normalized key; the server consumes the handoff with the key it
  // receives, so the handoff identity and the RPC key must match. Prefer the
  // normalized key and fall back to the raw key, sending whichever key the
  // handoff was actually created for.
  let rpcSessionKey = resolved.normalizedKey;
  let admissionHandoffId: string | undefined;
  if (params.storePath) {
    admissionHandoffId = createSessionWorkAdmissionHandoffForCurrent({
      scope: params.storePath,
      identities: [resolved.normalizedKey],
    });
    if (admissionHandoffId === undefined && params.sessionKey !== resolved.normalizedKey) {
      admissionHandoffId = createSessionWorkAdmissionHandoffForCurrent({
        scope: params.storePath,
        identities: [params.sessionKey],
      });
      if (admissionHandoffId !== undefined) {
        rpcSessionKey = params.sessionKey;
      }
    }
  }
  // A /close issued from a gateway client (e.g. Control UI) arrives as a chat run
  // and is itself registered in the gateway's chat-run table. The nested
  // sessions.delete aborts competing runs on this session before deleting; without
  // exempting the initiating run, that abort would terminate this very turn and the
  // client would surface an "aborted" state instead of the deletion success reply.
  // Pass the initiating run id so the server skips it during the session-wide abort.
  const exemptChatRunId = params.opts?.runId;
  const transcriptOwner = {
    sessionKey: resolved.normalizedKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(targetEntry?.sessionId ? { expectedSessionId: targetEntry.sessionId } : {}),
  };
  type SessionDeletionResult = {
    deleted?: boolean;
    archived?: string[];
    worktreePreserved?: { id: string; branch: string; path: string };
  };
  let deletion: SessionDeletionResult | undefined;
  try {
    deletion = await callGateway<SessionDeletionResult>({
      method: "sessions.delete",
      // The gateway may drain OTHER competing admitted work for up to
      // SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS and afterwards runs the worktree
      // cleanup before it reports back, so the budget covers both phases instead
      // of only the drain contract (the previous 20s budget timed out during any
      // slow post-mutation cleanup even though the deletion had committed).
      timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS + DELETE_SESSION_CLEANUP_ALLOWANCE_MS,
      params: {
        key: rpcSessionKey,
        deleteTranscript: true,
        // Bind the deletion to the incarnation the user closed: if a concurrent /new,
        // reset, or rollover rotates this key first, the gateway returns "session
        // changed" instead of deleting the replacement session. updatedAt is NOT part
        // of that binding: label edits, pinned-state changes, or any metadata touch
        // bump it without rotating the session, and binding to it would make /close
        // spuriously fail for the very session the user is looking at.
        expectedSessionId: targetEntry?.sessionId,
        expectedLifecycleRevision: targetEntry?.lifecycleRevision,
        ...(admissionHandoffId ? { admissionHandoffId } : {}),
        ...(exemptChatRunId ? { exemptChatRunId } : {}),
      },
    });
  } catch (err) {
    // The RPC deletes the session before the worktree cleanup that delays the
    // response, so an expired budget does NOT mean the close failed. Report the
    // uncertainty honestly instead of an error and leave the local store entry
    // untouched; the next sync reconciles it if the deletion committed.
    if (isGatewayTransportError(err) && err.kind === "timeout") {
      // The deletion usually committed by now, so this uncertainty reply must
      // not resurrect the (likely deleted) transcript either.
      return deleteSessionOutcomeReply(
        "Closing this session is taking longer than expected. The deletion may have completed with its cleanup still running; check the session list before retrying.",
        transcriptOwner,
      );
    }
    throw err;
  }
  if (!deletion?.deleted) {
    return deleteSessionReply("No active session was found to delete.");
  }

  if (params.sessionStore) {
    delete params.sessionStore[resolved.normalizedKey];
    for (const legacyKey of resolved.legacyKeys) {
      delete params.sessionStore[legacyKey];
    }
  }
  params.sessionEntry = undefined;
  markCommandSessionMetadataChanged(params);
  const wasArchived = (deletion.archived?.length ?? 0) > 0;
  const closedVerb = wasArchived ? "closed and archived" : "closed";
  // The session is gone, but if its managed worktree could not be removed the
  // gateway reports it as preserved: dirty or unpushed work remains in an
  // ownerless checkout. Surface it (like the Sessions UI does) instead of
  // reporting an unconditional success that hides the cleanup failure.
  if (deletion.worktreePreserved) {
    const { branch, path } = deletion.worktreePreserved;
    return deleteSessionOutcomeReply(
      `✅ Session ${closedVerb}.\n⚠️ Its worktree could not be removed and may hold uncommitted or unpushed work: branch “${branch}” at ${path}. Remove it manually when you no longer need it.`,
      transcriptOwner,
    );
  }
  // Incognito sessions delete the transcript without archiving it, so only claim
  // an archive when the gateway actually produced one; otherwise reporting
  // "archived" would mislead in the privacy-sensitive delete-without-archive case.
  return deleteSessionOutcomeReply(
    wasArchived
      ? "✅ Session closed and archived."
      : "✅ Session closed. Its transcript was not archived.",
    transcriptOwner,
  );
};
