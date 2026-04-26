import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import { resetConfiguredBindingTargetInPlace } from "../../channels/plugins/binding-targets.js";
import { updateSessionStoreEntry } from "../../config/sessions/store.js";
import { logVerbose } from "../../globals.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import { resolveBoundAcpThreadSessionKey } from "./commands-acp/targets.js";
import { emitResetCommandHooks, type ResetCommandAction } from "./commands-reset-hooks.js";
import { parseSoftResetCommand } from "./commands-reset-mode.js";
import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";
import { isResetAuthorizedForContext } from "./reset-authorization.js";

function applyAcpResetTailContext(ctx: HandleCommandsParams["ctx"], resetTail: string): void {
  const mutableCtx = ctx as Record<string, unknown>;
  mutableCtx.Body = resetTail;
  mutableCtx.RawBody = resetTail;
  mutableCtx.CommandBody = resetTail;
  mutableCtx.BodyForCommands = resetTail;
  mutableCtx.BodyForAgent = resetTail;
  mutableCtx.BodyStripped = resetTail;
  mutableCtx.AcpDispatchTailAfterReset = true;
}

function isResetAuthorized(params: HandleCommandsParams): boolean {
  return isResetAuthorizedForContext({
    ctx: params.ctx,
    cfg: params.cfg,
    commandAuthorized: params.command.isAuthorizedSender || params.ctx.CommandAuthorized === true,
  });
}

export async function maybeHandleResetCommand(
  params: HandleCommandsParams,
): Promise<CommandHandlerResult | null> {
  const softReset = parseSoftResetCommand(params.command.commandBodyNormalized);
  if (softReset.matched) {
    if (!isResetAuthorized(params)) {
      logVerbose(
        `Ignoring /reset soft from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }

    const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
    const boundAcpKey =
      boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey)
        ? boundAcpSessionKey.trim()
        : undefined;
    if (boundAcpKey) {
      return {
        shouldContinue: false,
        reply: { text: "Usage: /reset soft is not available for ACP-bound sessions yet." },
      };
    }

    const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
    const previousSessionEntry =
      params.previousSessionEntry ?? (targetSessionEntry ? { ...targetSessionEntry } : undefined);
    if (targetSessionEntry) {
      const now = Date.now();
      clearAllCliSessions(targetSessionEntry);
      if (params.sessionEntry && params.sessionEntry !== targetSessionEntry) {
        clearAllCliSessions(params.sessionEntry);
        params.sessionEntry.updatedAt = now;
        params.sessionEntry.lastInteractionAt = now;
      }
      if (params.sessionKey) {
        clearBootstrapSnapshot(params.sessionKey);
      }
      targetSessionEntry.updatedAt = now;
      targetSessionEntry.lastInteractionAt = now;
      if (params.sessionStore && params.sessionKey) {
        params.sessionStore[params.sessionKey] = targetSessionEntry;
      }
      if (params.storePath && params.sessionKey) {
        await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async (entry) => {
            const next = { ...entry };
            clearAllCliSessions(next);
            return {
              cliSessionBindings: next.cliSessionBindings,
              cliSessionIds: next.cliSessionIds,
              claudeCliSessionId: next.claudeCliSessionId,
              updatedAt: now,
              lastInteractionAt: now,
            };
          },
        });
      }
    }

    await emitResetCommandHooks({
      action: "reset",
      ctx: params.ctx,
      cfg: params.cfg,
      command: params.command,
      sessionKey: params.sessionKey,
      sessionEntry: targetSessionEntry,
      previousSessionEntry,
      workspaceDir: params.workspaceDir,
    });
    params.command.softResetTriggered = true;
    params.command.softResetTail = softReset.tail;
    return null;
  }

  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
  if (!resetMatch) {
    return null;
  }
  if (!isResetAuthorized(params)) {
    logVerbose(
      `Ignoring /reset from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const commandAction: ResetCommandAction = resetMatch[1] === "reset" ? "reset" : "new";
  const resetTail = params.command.commandBodyNormalized.slice(resetMatch[0].length).trimStart();
  const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
  const boundAcpKey =
    boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey)
      ? boundAcpSessionKey.trim()
      : undefined;
  if (boundAcpKey) {
    const resetResult = await resetConfiguredBindingTargetInPlace({
      cfg: params.cfg,
      sessionKey: boundAcpKey,
      reason: commandAction,
      commandSource: `${params.command.surface}:${params.ctx.CommandSource ?? "text"}`,
    });
    if (!resetResult.ok) {
      logVerbose(`acp reset failed for ${boundAcpKey}: ${resetResult.error ?? "unknown error"}`);
    }
    if (resetResult.ok) {
      params.command.resetHookTriggered = true;
      if (resetTail) {
        applyAcpResetTailContext(params.ctx, resetTail);
        if (params.rootCtx && params.rootCtx !== params.ctx) {
          applyAcpResetTailContext(params.rootCtx, resetTail);
        }
        return { shouldContinue: false };
      }
      return {
        shouldContinue: false,
        reply: { text: "✅ ACP session reset in place." },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: "⚠️ ACP session reset failed. Check /acp status and try again." },
    };
  }

  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  await emitResetCommandHooks({
    action: commandAction,
    ctx: params.ctx,
    cfg: params.cfg,
    command: params.command,
    sessionKey: params.sessionKey,
    sessionEntry: targetSessionEntry,
    previousSessionEntry: params.previousSessionEntry,
    workspaceDir: params.workspaceDir,
  });
  return null;
}
