import {
  resolveAgentExplicitModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
/** Handles /new and /reset command flows, including soft reset and ACP-bound sessions. */
import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import {
  getPreparedModelCatalogSnapshot,
  loadPreparedModelCatalogSnapshot,
  type LoadPreparedModelCatalogParams,
} from "../../agents/prepared-model-catalog.js";
import { resetConfiguredBindingTargetInPlace } from "../../channels/plugins/binding-targets.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
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
import type { ReplySessionBinding } from "./get-reply.types.js";
import { isResetAuthorizedForContext } from "./reset-authorization.js";

type InternalResetCommandOptions = NonNullable<HandleCommandsParams["opts"]> & {
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
};

function applyAcpResetTailContext(ctx: HandleCommandsParams["ctx"], resetTail: string): void {
  applyCommandTextToContext(ctx, resetTail);
  // Mark the context so ACP dispatch continues with the post-reset tail, not the reset command.
  ctx.AcpDispatchTailAfterReset = true;
}

function collectConfiguredModelRefs(
  params: HandleCommandsParams,
  catalog: ModelCatalogSnapshot | undefined,
): Set<string> {
  const refs = new Set<string>();
  const addModelRefValue = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return;
    }
    refs.add(normalized);
    const slash = normalized.indexOf("/");
    if (slash > 0) {
      refs.add(normalized.slice(0, slash));
      refs.add(normalized.slice(slash + 1));
    }
  };
  const providers = (
    params.cfg as {
      models?: {
        providers?: Record<string, { models?: Array<Record<string, unknown>> }>;
      };
    }
  ).models?.providers;
  for (const [providerId, provider] of Object.entries(providers ?? {})) {
    refs.add(providerId.toLowerCase());
    for (const model of provider.models ?? []) {
      // Only the model ID is honored by the canonical reset-model resolver
      // (buildAllowedModelSetWithFallbacks keys allowed models on entry.id, not on display
      // names), so a single-word display name must NOT be treated as a directive here or a
      // legitimate `/new <Name> …` title would divergently be dispatched as an unresolvable
      // prompt instead of naming the session. Aliases are matched separately via the alias index.
      const modelId = typeof model.id === "string" ? model.id.trim() : "";
      if (!modelId) {
        continue;
      }
      refs.add(modelId.toLowerCase());
      refs.add(`${providerId}/${modelId}`.toLowerCase());
    }
  }
  // Configured primary/fallback models may not be duplicated under models.providers,
  // but the reset-model resolver still honors them, so treat them as model refs here.
  // Use the canonical helpers so the supported string shorthand for agents.defaults.model
  // is resolved too, not just the object form.
  const defaultsModel = params.cfg.agents?.defaults?.model;
  addModelRefValue(resolveAgentModelPrimaryValue(defaultsModel));
  for (const fallback of resolveAgentModelFallbackValues(defaultsModel)) {
    addModelRefValue(fallback);
  }
  // Per-agent overrides are honored by the canonical reset-model resolver but are
  // absent from models.providers and the defaults model. Only the ACTIVE agent's
  // override matters here: the reset-model resolver scopes allowed model keys to the
  // active agent, so folding in every agent's overrides would misclassify another
  // agent's private model as a directive and drop a legitimate session name. The
  // active agent falls back to the default agent when the turn has no explicit id,
  // matching resolveDefaultModel's own agent scoping.
  const activeAgentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  if (activeAgentId) {
    addModelRefValue(resolveAgentExplicitModelPrimary(params.cfg, activeAgentId));
    for (const fallback of resolveAgentModelFallbacksOverride(params.cfg, activeAgentId) ?? []) {
      addModelRefValue(fallback);
    }
  }
  // Plugin-supplied providers publish their models only into the prepared model
  // catalog, not into cfg.models.providers, so a bare plugin ref like "acme/widget"
  // is invisible to the config-only refs above and would be captured as a session
  // name even though the reset-model resolver honors it. Fold in the already
  // published catalog to recognize it as a directive instead. The caller passes the
  // CURRENT published catalog snapshot (or undefined until it is warm), so the config
  // refs degrade gracefully without cold-loading plugins here on the /new hot path.
  for (const entry of catalog?.entries ?? []) {
    const providerId = typeof entry.provider === "string" ? entry.provider.trim() : "";
    if (providerId) {
      refs.add(providerId.toLowerCase());
    }
    // Mirror only the catalog model ID, not its display name, for the same reason as the
    // configured providers above: the reset-model resolver keys allowed models on the ID
    // (and honors aliases separately), so folding in display names would misclassify a
    // plain `/new <Name> …` title as a model directive.
    const entryId = typeof entry.id === "string" ? entry.id.trim() : "";
    if (entryId) {
      refs.add(entryId.toLowerCase());
      if (providerId) {
        refs.add(`${providerId}/${entryId}`.toLowerCase());
      }
    }
  }
  return refs;
}

const MODEL_REF_PREFIX_RE =
  /^(?:gpt|o[134]|claude|gemini|llama|mistral|mixtral|codestral|qwen|deepseek|grok|kimi|command-r|sonar|phi)(?:[-_:./]|\d|$)/i;

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
  const normalized = tail.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const activeAgentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  const catalogParams: LoadPreparedModelCatalogParams = {
    config: params.cfg,
    ...(activeAgentId ? { agentId: activeAgentId } : {}),
  };
  const warmCatalog = getPreparedModelCatalogSnapshot(catalogParams);
  const refs = collectConfiguredModelRefs(params, warmCatalog);
  const tokens = normalized.split(/\s+/);
  const firstToken = tokens[0] ?? "";
  // A leading provider/model ref (e.g. a configured primary) is a model directive even when
  // trailing tokens form a prompt, so it must not be captured as a session name.
  if (firstToken.includes("/") && refs.has(firstToken)) {
    return true;
  }
  if (tokens.length >= 2 && !firstToken.includes("/")) {
    const [provider, model] = tokens;
    if (provider && model && refs.has(provider)) {
      return refs.has(`${provider}/${model}`) || refs.has(model) || MODEL_REF_PREFIX_RE.test(model);
    }
  }
  // Classify by the FIRST token, not the whole tail: `/new opus summarize this` leads with a
  // model alias and must fall through to the reset-model resolver (opus + prompt), not be
  // captured verbatim as a multi-word session name. Scope the alias index to the active agent
  // (matching the canonical directive path) so an alias defined only under the selected agent's
  // `agents.list[].models` is recognized instead of dropping the trailing prompt into the title.
  if (
    !firstToken.includes("/") &&
    buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: params.provider || DEFAULT_PROVIDER,
      agentId: activeAgentId,
      allowPluginNormalization: false,
    }).byAlias.has(firstToken)
  ) {
    return true;
  }
  if (refs.has(firstToken)) {
    return true;
  }
  // MODEL_REF_PREFIX_RE is anchored at the start, so this classifies the leading token: a
  // single well-formed model ref (`/new gpt-5.6-sol`) or a leading ref plus prompt
  // (`/new gpt-5.6-sol summarize this`) both fall through to the reset-model resolver.
  if (MODEL_REF_PREFIX_RE.test(firstToken)) {
    return true;
  }
  // Cold-catalog escalation: a provider/model-shaped leading token that neither the config refs
  // nor the warm snapshot could resolve is only ambiguous while the catalog is still cold
  // (snapshot undefined) right after startup or an agent switch. Resolve it on demand exactly
  // once so a plugin-supplied model is honored as a directive instead of being frozen as a
  // session name. The common no-slash name path never reaches here, and once the catalog is warm
  // the snapshot is defined so this never runs; the reset-model resolver downstream would
  // cold-load anyway for any tail it treats as a directive, so this only shifts that same load
  // slightly earlier for the narrow ambiguous case.
  if (firstToken.includes("/") && warmCatalog === undefined) {
    return resolveColdPluginModelRef(catalogParams, firstToken);
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
    const writeResult = await writeSessionLabel(params, newSessionTitle);
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
