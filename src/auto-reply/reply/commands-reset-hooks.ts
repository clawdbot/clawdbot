// Emits reset hooks and cleanup work around session reset commands.
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { selectSessionTranscriptLeafControlledPath } from "../../config/sessions/transcript-tree.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { HandleCommandsParams } from "./commands-types.js";

const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));

function loadRouteReplyRuntime() {
  return routeReplyRuntimeLoader.load();
}

export type ResetCommandAction = "new" | "reset";

function parseTranscriptMessages(entries: unknown[]): unknown[] {
  const selectedEntries = selectSessionTranscriptLeafControlledPath(entries) ?? entries;
  return selectedEntries.flatMap((entry) => {
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { type?: unknown }).type === "message" &&
      (entry as { message?: unknown }).message
    ) {
      return [(entry as { message: unknown }).message];
    }
    return [];
  });
}

async function loadBeforeResetTranscript(params: {
  agentId?: string;
  sessionId?: string;
  sessionFile?: string;
  sessionKey?: string;
  storePath?: string;
}): Promise<{ sessionFile?: string; messages: unknown[] }> {
  if (!params.sessionId || !params.sessionKey || !params.storePath) {
    logVerbose("before_reset: no session identity available, firing hook with empty messages");
    return { sessionFile: params.sessionFile, messages: [] };
  }
  try {
    return {
      sessionFile: params.sessionFile,
      messages: parseTranscriptMessages(
        // before_reset snapshots the canonical pre-reset rows. sessionFile is
        // hook metadata only and must not be treated as a readable path.
        await loadTranscriptEvents({
          ...(params.agentId ? { agentId: params.agentId } : {}),
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        }),
      ),
    };
  } catch (err: unknown) {
    logVerbose(
      `before_reset: failed to read transcript identity ${params.sessionKey}/${params.sessionId}; firing hook with empty messages (${String(err)})`,
    );
    return { sessionFile: params.sessionFile, messages: [] };
  }
}

export async function emitResetCommandHooks(params: {
  action: ResetCommandAction;
  ctx: HandleCommandsParams["ctx"];
  cfg: HandleCommandsParams["cfg"];
  command: Pick<
    HandleCommandsParams["command"],
    "surface" | "senderId" | "channel" | "from" | "to" | "resetHookTriggered"
  >;
  sessionKey?: string;
  storePath?: string;
  sessionEntry?: HandleCommandsParams["sessionEntry"];
  previousSessionEntry?: HandleCommandsParams["previousSessionEntry"];
  workspaceDir: string;
}): Promise<{ routedReply: boolean }> {
  const hookEvent = createInternalHookEvent("command", params.action, params.sessionKey ?? "", {
    sessionEntry: params.sessionEntry,
    previousSessionEntry: params.previousSessionEntry,
    commandSource: params.command.surface,
    senderId: params.command.senderId,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  await triggerInternalHook(hookEvent);
  params.command.resetHookTriggered = true;

  let routedReply = false;
  if (hookEvent.messages.length > 0) {
    const channel = params.ctx.OriginatingChannel || params.command.channel;
    const to = params.ctx.OriginatingTo || params.command.from || params.command.to;
    if (channel && to) {
      const { routeReply } = await loadRouteReplyRuntime();
      await routeReply({
        payload: { text: hookEvent.messages.join("\n\n") },
        channel,
        to,
        sessionKey: params.sessionKey,
        accountId: params.ctx.AccountId,
        requesterSenderId: params.command.senderId,
        requesterSenderName: params.ctx.SenderName,
        requesterSenderUsername: params.ctx.SenderUsername,
        requesterSenderE164: params.ctx.SenderE164,
        threadId: params.ctx.MessageThreadId,
        cfg: params.cfg,
        replyKind: "final",
      });
      routedReply = true;
    }
  }

  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_reset")) {
    const prevEntry = params.previousSessionEntry;
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    const beforeResetTranscript = await loadBeforeResetTranscript({
      agentId,
      sessionFile: prevEntry?.sessionFile,
      sessionId: prevEntry?.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    void (async () => {
      try {
        await hookRunner.runBeforeReset(
          { ...beforeResetTranscript, reason: params.action },
          {
            agentId,
            sessionKey: params.sessionKey,
            sessionId: prevEntry?.sessionId,
            workspaceDir: params.workspaceDir,
          },
        );
      } catch (err: unknown) {
        logVerbose(`before_reset hook failed: ${String(err)}`);
      }
    })();
  }
  return { routedReply };
}
