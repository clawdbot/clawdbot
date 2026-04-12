import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  resolveAbortCutoffFromContext,
  shouldPersistAbortCutoff,
  type AbortCutoff,
} from "./abort-cutoff.js";
import {
  formatAbortReplyText,
  isAbortTrigger,
  resolveSessionEntryForKey,
  setAbortMemory,
  stopSubagentsForRequester,
} from "./abort.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { persistAbortTargetEntry } from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";
import { clearSessionQueues } from "./queue.js";
import { replyRunRegistry } from "./reply-run-registry.js";

type AbortTarget = {
  entry?: SessionEntry;
  key?: string;
  sessionId?: string;
};

async function abortEmbeddedPiRunForSession(sessionId: string): Promise<void> {
  const { abortEmbeddedPiRun } = await import("../../agents/pi-embedded-runner/runs.js");
  abortEmbeddedPiRun(sessionId);
}

function resolveAbortTarget(params: {
  ctx: { CommandTargetSessionKey?: string | null };
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
}): AbortTarget {
  const targetSessionKey =
    normalizeOptionalString(params.ctx.CommandTargetSessionKey) || params.sessionKey;
  const { entry, key } = resolveSessionEntryForKey(params.sessionStore, targetSessionKey);
  if (entry && key) {
    return {
      entry,
      key,
      sessionId: replyRunRegistry.resolveSessionId(key) ?? entry.sessionId,
    };
  }
  if (
    params.sessionEntry &&
    params.sessionKey &&
    (!targetSessionKey || targetSessionKey === params.sessionKey)
  ) {
    return {
      entry: params.sessionEntry,
      key: params.sessionKey,
      sessionId:
        replyRunRegistry.resolveSessionId(params.sessionKey) ?? params.sessionEntry.sessionId,
    };
  }
  return {
    entry: undefined,
    key: targetSessionKey,
    sessionId: targetSessionKey ? replyRunRegistry.resolveSessionId(targetSessionKey) : undefined,
  };
}

function resolveAbortCutoffForTarget(params: {
  ctx: Parameters<CommandHandler>[0]["ctx"];
  commandSessionKey?: string;
  targetSessionKey?: string;
}): AbortCutoff | undefined {
  if (
    !shouldPersistAbortCutoff({
      commandSessionKey: params.commandSessionKey,
      targetSessionKey: params.targetSessionKey,
    })
  ) {
    return undefined;
  }
  return resolveAbortCutoffFromContext(params.ctx);
}

async function applyAbortTarget(params: {
  abortTarget: AbortTarget;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  abortKey?: string;
  abortCutoff?: AbortCutoff;
}) {
  const { abortTarget } = params;
  if (abortTarget.key) {
    replyRunRegistry.abort(abortTarget.key);
  }
  if (abortTarget.sessionId) {
    await abortEmbeddedPiRunForSession(abortTarget.sessionId);
  }

  const persisted = await persistAbortTargetEntry({
    entry: abortTarget.entry,
    key: abortTarget.key,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    abortCutoff: params.abortCutoff,
  });
  if (!persisted && params.abortKey) {
    setAbortMemory(params.abortKey, true);
  }
}

function buildAbortTargetApplyParams(
  params: Parameters<CommandHandler>[0],
  abortTarget: AbortTarget,
) {
  return {
    abortTarget,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    abortKey: params.command.abortKey,
    abortCutoff: resolveAbortCutoffForTarget({
      ctx: params.ctx,
      commandSessionKey: params.sessionKey,
      targetSessionKey: abortTarget.key,
    }),
  };
}

export const handleStopCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/stop") {
    return null;
  }
  const unauthorizedStop = rejectUnauthorizedCommand(params, "/stop");
  if (unauthorizedStop) {
    return unauthorizedStop;
  }
  const abortTarget = resolveAbortTarget({
    ctx: params.ctx,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
  });
  const cleared = clearSessionQueues([abortTarget.key, abortTarget.sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `stop: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }
  await applyAbortTarget(buildAbortTargetApplyParams(params, abortTarget));

  // Trigger internal hook for stop command
  const hookEvent = createInternalHookEvent(
    "command",
    "stop",
    abortTarget.key ?? params.sessionKey ?? "",
    {
      sessionEntry: abortTarget.entry,
      sessionId: abortTarget.sessionId,
      commandSource: params.command.surface,
      senderId: params.command.senderId,
    },
  );
  await triggerInternalHook(hookEvent);

  const { stopped } = stopSubagentsForRequester({
    cfg: params.cfg,
    requesterSessionKey: abortTarget.key ?? params.sessionKey,
  });

  return { shouldContinue: false, reply: { text: formatAbortReplyText(stopped) } };
};

export const handleAbortTrigger: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (!isAbortTrigger(params.command.rawBodyNormalized)) {
    return null;
  }
  const unauthorizedAbortTrigger = rejectUnauthorizedCommand(params, "abort trigger");
  if (unauthorizedAbortTrigger) {
    return unauthorizedAbortTrigger;
  }
  const abortTarget = resolveAbortTarget({
    ctx: params.ctx,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
  });
  await applyAbortTarget(buildAbortTargetApplyParams(params, abortTarget));
  return { shouldContinue: false, reply: { text: "⚙️ Agent was aborted." } };
};
