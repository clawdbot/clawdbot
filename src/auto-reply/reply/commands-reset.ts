import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveAgentModelFallbacksOverride,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
/** Handles /new and /reset command flows, including soft reset and ACP-bound sessions. */
import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import {
  buildAllowedModelSetWithFallbacks,
  isModelKeyAllowedBySet,
} from "../../agents/model-selection-shared.js";
import {
  getPreparedModelCatalogSnapshot,
  loadPreparedModelCatalogSnapshot,
  type LoadPreparedModelCatalogParams,
} from "../../agents/prepared-model-catalog.js";
import { resetConfiguredBindingTargetInPlace } from "../../channels/plugins/binding-targets.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import { applyCommandTextToContext } from "./command-context-rewrite.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import { resolveBoundAcpThreadSessionKey } from "./commands-acp/targets.js";
import { writeSessionLabel } from "./commands-name.js";
import { emitResetCommandHooks, type ResetCommandAction } from "./commands-reset-hooks.js";
import { parseSoftResetCommand } from "./commands-reset-mode.js";
import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";
import type { ReplySessionBinding } from "./get-reply.types.js";
import {
  modelKey,
  resolveModelDirectiveSelection,
  resolveModelRefFromDirectiveString,
} from "./model-selection-directive.js";
import { isResetAuthorizedForContext } from "./reset-authorization.js";

type InternalResetCommandOptions = NonNullable<HandleCommandsParams["opts"]> & {
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
};

function applyAcpResetTailContext(ctx: HandleCommandsParams["ctx"], resetTail: string): void {
  applyCommandTextToContext(ctx, resetTail);
  // Mark the context so ACP dispatch continues with the post-reset tail, not the reset command.
  ctx.AcpDispatchTailAfterReset = true;
}

async function resolveColdPluginModelRef(
  catalogParams: LoadPreparedModelCatalogParams,
  firstToken: string,
): Promise<boolean> {
  try {
    const catalog = await loadPreparedModelCatalogSnapshot(catalogParams);
    for (const entry of catalog.entries) {
      const providerId =
        typeof entry.provider === "string" ? entry.provider.trim().toLowerCase() : "";
      if (!providerId) {
        continue;
      }
      // Match only the model ID (not the display name), mirroring the reset-model resolver's
      // allowed keys so classification never diverges from what the resolver can select.
      const entryId = typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
      if (entryId && `${providerId}/${entryId}` === firstToken) {
        return true;
      }
    }
  } catch (err) {
    logVerbose(
      `Cold plugin model resolution failed for "${firstToken}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return false;
}

async function isModelRefTail(params: HandleCommandsParams, tail: string): Promise<boolean> {
  const tokens = tail.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (!first) {
    return false;
  }
  const second = tokens[1];
  const activeAgentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  const catalogParams: LoadPreparedModelCatalogParams = {
    config: params.cfg,
    ...(activeAgentId ? { agentId: activeAgentId } : {}),
  };
  // Mirror the canonical reset-model resolver (applyResetModelOverride) so
  // classification never diverges from what the resolver would actually select:
  // build the same allowed-model key set and run the same resolution attempts.
  // The only difference is the catalog source — classification must stay cheap on
  // the /new hot path, so it uses the already published snapshot (or none while
  // cold) instead of cold-loading plugins the way the resolver does downstream.
  const warmCatalog = getPreparedModelCatalogSnapshot(catalogParams);
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg: params.cfg,
    ...(activeAgentId ? { agentId: activeAgentId } : {}),
  });
  const fallbackModels =
    (activeAgentId ? resolveAgentModelFallbacksOverride(params.cfg, activeAgentId) : undefined) ??
    resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  const allowed = buildAllowedModelSetWithFallbacks({
    cfg: params.cfg,
    catalog: warmCatalog?.entries ?? [],
    defaultProvider,
    defaultModel,
    fallbackModels,
    ...(activeAgentId ? { agentId: activeAgentId } : {}),
    aliasIndex,
    allowPluginNormalization: false,
  });
  const allowedModelKeys = allowed.allowedKeys;
  if (allowed.allowAny && defaultModel.trim()) {
    allowedModelKeys.add(modelKey(normalizeProviderId(defaultProvider), defaultModel.trim()));
  }
  if (allowedModelKeys.size > 0) {
    const providers = new Set<string>();
    for (const key of allowedModelKeys) {
      const slash = key.indexOf("/");
      if (slash <= 0) {
        continue;
      }
      providers.add(normalizeProviderId(key.slice(0, slash)));
    }
    const resolveSelection = (raw: string) =>
      resolveModelDirectiveSelection({
        raw,
        defaultProvider,
        defaultModel,
        aliasIndex,
        allowedModelKeys,
        cfg: params.cfg,
        ...(activeAgentId ? { agentId: activeAgentId } : {}),
      });
    // Attempt 1: `provider model …` split across the first two tokens.
    if (providers.has(normalizeProviderId(first)) && second) {
      if (resolveSelection(`${normalizeProviderId(first)}/${second}`).selection) {
        return true;
      }
    }
    // Attempt 2: explicit ref or alias, allowlist-checked like the resolver.
    const explicit = resolveModelRefFromDirectiveString({
      raw: first,
      defaultProvider,
      aliasIndex,
    });
    if (explicit) {
      // An exact alias hit is unambiguous model intent: the alias index is already
      // scoped to the active agent, so even when the aliased model is missing from
      // the allowlist the tail must fall through to the reset-model resolver, which
      // owns policy enforcement (and its error messaging) for the directive.
      if (explicit.alias) {
        return true;
      }
      if (
        isModelKeyAllowedBySet(
          allowedModelKeys,
          modelKey(explicit.ref.provider, explicit.ref.model),
        )
      ) {
        return true;
      }
    }
    // Attempt 3: fuzzy match, gated exactly like the resolver.
    const allowFuzzy = providers.has(normalizeProviderId(first)) || first.trim().length >= 6;
    if (allowFuzzy && resolveSelection(first).selection) {
      return true;
    }
  }
  // Cold-catalog escalation: a provider/model-shaped leading token that the config-derived
  // allowlist could not resolve is only ambiguous while the catalog is still cold (snapshot
  // undefined) right after startup or an agent switch. Resolve it on demand exactly once so a
  // plugin-supplied model is honored as a directive instead of being frozen as a session name.
  // Once the catalog is warm the snapshot is defined so this never runs; the reset-model
  // resolver downstream would cold-load anyway for any tail it treats as a directive, so this
  // only shifts that same load slightly earlier for the narrow ambiguous case.
  const firstLower = first.toLowerCase();
  if (firstLower.includes("/") && warmCatalog === undefined) {
    return resolveColdPluginModelRef(catalogParams, firstLower);
  }
  return false;
}

function getNativeCommandTitleTail(params: HandleCommandsParams): string | undefined {
  if ((params.ctx.CommandSource ?? "text") === "text") {
    return undefined;
  }
  const title = params.ctx.CommandArgs?.values?.title;
  if (typeof title !== "string" || !title.trim()) {
    return undefined;
  }
  const trimmed = title.trim();
  const newMatch = trimmed.match(/^\/new(?:\s+(.+))?$/i);
  return newMatch ? newMatch[1]?.trim() : trimmed;
}

function parseExplicitNamedNewSessionTail(tail: string): string | undefined {
  if (/^(?:--model(?:=|\s+)|model:)/i.test(tail)) {
    return undefined;
  }
  const flagMatch = tail.match(/^--name(?:=|\s+)(.+)$/i);
  if (flagMatch?.[1]) {
    return flagMatch[1].trim();
  }
  const prefixMatch = tail.match(/^name:(.+)$/i);
  if (prefixMatch?.[1]) {
    return prefixMatch[1].trim();
  }
  return undefined;
}

async function parseNamedNewSessionTail(
  params: HandleCommandsParams,
  resetTail: string,
): Promise<string | undefined> {
  const nativeTitle = getNativeCommandTitleTail(params);
  if (nativeTitle) {
    const explicitNativeName = parseExplicitNamedNewSessionTail(nativeTitle);
    if (explicitNativeName) {
      return explicitNativeName;
    }
    // Mirror the text path: an explicit model flag is a directive for the reset-model
    // resolver, never a session name, even though it is not a bare model ref.
    if (/^(?:--model(?:=|\s+)|model:)/i.test(nativeTitle)) {
      return undefined;
    }
    return (await isModelRefTail(params, nativeTitle)) ? undefined : nativeTitle;
  }
  const tail = resetTail.trim();
  if (!tail) {
    return undefined;
  }
  const explicitName = parseExplicitNamedNewSessionTail(tail);
  if (explicitName) {
    return explicitName;
  }
  if (/^(?:--model(?:=|\s+)|model:)/i.test(tail)) {
    return undefined;
  }
  return undefined;
}

function isResetAuthorized(params: HandleCommandsParams): boolean {
  return isResetAuthorizedForContext({
    ctx: params.ctx,
    cfg: params.cfg,
    commandAuthorized: params.command.isAuthorizedSender || params.ctx.CommandAuthorized === true,
  });
}

/** Handles reset/new commands or returns null when another command handler should continue. */
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
        await updateSessionEntry(
          {
            storePath: params.storePath,
            sessionKey: params.sessionKey,
          },
          async (entry) => {
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
        );
      }
    }

    await emitResetCommandHooks({
      action: "reset",
      agentId: params.agentId,
      ctx: params.ctx,
      cfg: params.cfg,
      command: params.command,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      sessionEntry: targetSessionEntry,
      previousSessionEntry,
      onObservedReplyDelivery: params.opts?.onObservedReplyDelivery,
      workspaceDir: params.workspaceDir,
    });
    params.command.softResetTriggered = true;
    params.command.softResetTail = softReset.tail;
    return null;
  }

  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/i);
  if (!resetMatch) {
    return null;
  }
  if (!isResetAuthorized(params)) {
    logVerbose(
      `Ignoring /reset from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const commandAction: ResetCommandAction =
    resetMatch[1]?.toLowerCase() === "reset" ? "reset" : "new";
  const resetTail = params.command.commandBodyNormalized.slice(resetMatch[0].length).trimStart();
  const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
  const boundAcpKey =
    boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey)
      ? boundAcpSessionKey.trim()
      : undefined;
  if (boundAcpKey) {
    if (commandAction === "new" && (await parseNamedNewSessionTail(params, resetTail))) {
      return {
        shouldContinue: false,
        reply: { text: "Naming a new session isn't supported for ACP-bound sessions yet." },
      };
    }
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
      if (resetResult.sessionId) {
        (params.opts as InternalResetCommandOptions | undefined)?.onSessionPrepared?.({
          sessionKey: resetResult.sessionKey ?? boundAcpKey,
          sessionId: resetResult.sessionId,
          storePath: resetResult.storePath,
        });
      }
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

  const hookResult = await emitResetCommandHooks({
    action: commandAction,
    agentId: params.agentId,
    ctx: params.ctx,
    cfg: params.cfg,
    command: params.command,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    sessionEntry: targetSessionEntry,
    previousSessionEntry: params.previousSessionEntry,
    onObservedReplyDelivery: params.opts?.onObservedReplyDelivery,
    workspaceDir: params.workspaceDir,
  });
  const newSessionTitle =
    commandAction === "new" ? await parseNamedNewSessionTail(params, resetTail) : undefined;
  if (newSessionTitle) {
    // Bind the label to the incarnation this /new produced: hooks above are awaited and a
    // concurrent reset may have rotated the session since. Naming would otherwise relabel
    // the replacement session instead of the one the user just created.
    const writeResult = await writeSessionLabel(params, newSessionTitle, {
      ...(targetSessionEntry?.sessionId ? { expectedSessionId: targetSessionEntry.sessionId } : {}),
    });
    if (!writeResult.ok) {
      return {
        shouldContinue: false,
        reply: { text: `✅ New session started, but couldn't name it: ${writeResult.error}` },
      };
    }
    markCommandSessionMetadataChanged(params);
    return {
      shouldContinue: false,
      ...(hookResult.routedReply
        ? {}
        : { reply: { text: `✅ New session started as “${writeResult.label}”.` } }),
    };
  }
  if (!resetTail) {
    return {
      shouldContinue: false,
      ...(hookResult.routedReply
        ? {}
        : {
            reply: {
              text: commandAction === "reset" ? "✅ Session reset." : "✅ New session started.",
            },
          }),
    };
  }
  return null;
}
