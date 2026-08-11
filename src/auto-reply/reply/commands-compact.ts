// Implements compaction commands for session context and model state.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import {
  classifyCompactionReason,
  isBenignCompactionSkipResult,
} from "../../agents/embedded-agent-runner/compact-reasons.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  resolveContextConfigProviderForRuntime,
} from "../../agents/openai-routing.js";
import { resolveOwnerPromptNumbers } from "../../agents/owner-display.js";
import {
  resolvePersistedSessionRuntimeId,
  resolveSessionRuntimeOverrideForProvider,
} from "../../agents/session-runtime-compat.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CommandHandler } from "./commands-types.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

const compactRuntimeLoader = createLazyImportLoader(() => import("./commands-compact.runtime.js"));

function loadCompactRuntime(): Promise<typeof import("./commands-compact.runtime.js")> {
  return compactRuntimeLoader.load();
}

function extractCompactInstructions(params: {
  rawBody?: string;
  ctx: import("../templating.js").MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}): string | undefined {
  const raw = stripStructuralPrefixes(params.rawBody ?? "");
  const stripped = params.isGroup
    ? stripMentions(raw, params.ctx, params.cfg, params.agentId)
    : raw;
  const trimmed = stripped.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  const prefix = lowered.startsWith("/compact") ? "/compact" : null;
  if (!prefix) {
    return undefined;
  }
  let rest = trimmed.slice(prefix.length).trimStart();
  if (rest.startsWith(":")) {
    rest = rest.slice(1).trimStart();
  }
  return rest.length ? rest : undefined;
}

function formatCompactionReason(reason?: string): string | undefined {
  const text = normalizeOptionalString(reason);
  if (!text) {
    return undefined;
  }

  const classification = classifyCompactionReason(reason);
  const lower = normalizeLowercaseStringOrEmpty(reason);
  switch (classification) {
    case "no_compactable_entries":
      return "nothing compactable in this session yet";
    case "below_threshold":
      return lower.includes("already under target")
        ? "context is already under the compaction target"
        : "context is below the compaction threshold";
    case "already_compacted":
      return "session is already compacted";
    default:
      return text;
  }
}

function resolveManualCompactContextTokenBudget(params: {
  cfg: OpenClawConfig;
  provider?: string;
  model?: string;
  agentId: string;
  sessionKey: string;
  liveContextTokens?: number;
  persistedContextTokens?: number;
}): number | undefined {
  const inheritedContextTokens =
    typeof params.liveContextTokens === "number" &&
    Number.isFinite(params.liveContextTokens) &&
    params.liveContextTokens > 0
      ? Math.floor(params.liveContextTokens)
      : undefined;
  const liveContextTokens =
    resolvePersistedContextTokens(resolveAgentConfig(params.cfg, params.agentId)?.contextTokens) ??
    inheritedContextTokens;

  const model = normalizeOptionalString(params.model);
  const provider = normalizeOptionalString(params.provider);
  if (!model || !provider) {
    return liveContextTokens ?? resolvePersistedContextTokens(params.persistedContextTokens);
  }

  const harnessPolicy = resolveAgentHarnessPolicy({
    provider,
    modelId: model,
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const contextConfigProvider = resolveContextConfigProviderForRuntime({
    provider,
    runtimeId: harnessPolicy.runtime,
    config: params.cfg,
  });
  const configuredContextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: contextConfigProvider,
    model: resolveManualCompactContextModelId({
      provider,
      contextConfigProvider,
      model,
    }),
    allowAsyncLoad: false,
  });
  if (typeof configuredContextTokens === "number" && configuredContextTokens > 0) {
    const configuredBudget = Math.floor(configuredContextTokens);
    return liveContextTokens !== undefined
      ? Math.min(liveContextTokens, configuredBudget)
      : configuredBudget;
  }

  if (liveContextTokens !== undefined) {
    return liveContextTokens;
  }

  return resolvePersistedContextTokens(params.persistedContextTokens);
}

function resolvePersistedContextTokens(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function resolveManualCompactContextModelId(params: {
  provider: string;
  contextConfigProvider: string;
  model: string;
}): string {
  const model = params.model.trim();
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) {
    return model;
  }

  const modelProvider = normalizeProviderId(model.slice(0, slashIndex));
  const selectedProvider = normalizeProviderId(params.provider);
  const contextConfigProvider = normalizeProviderId(params.contextConfigProvider);
  const modelId = model.slice(slashIndex + 1).trim();
  if (!modelId) {
    return model;
  }

  if (
    modelProvider === selectedProvider ||
    modelProvider === contextConfigProvider ||
    (modelProvider === OPENAI_PROVIDER_ID && contextConfigProvider === OPENAI_CODEX_PROVIDER_ID)
  ) {
    return modelId;
  }

  return model;
}

export const handleCompactCommand: CommandHandler = async (params) => {
  const compactRequested =
    params.command.commandBodyNormalized === "/compact" ||
    params.command.commandBodyNormalized.startsWith("/compact ");
  if (!compactRequested) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /compact from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  if (!targetSessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚙️ Compaction unavailable (missing session id).",
        isStatusNotice: true,
      },
    };
  }
  const runtime = await loadCompactRuntime();
  const sessionId = targetSessionEntry.sessionId;
  if (runtime.isEmbeddedAgentRunAbortableForCompaction(sessionId)) {
    runtime.abortEmbeddedAgentRun(sessionId);
    const drained = await runtime.waitForEmbeddedAgentRunEnd(sessionId, 15_000);
    if (!drained) {
      return {
        shouldContinue: false,
        reply: {
          text: "⚙️ Compaction unavailable: the previous run is still stopping.",
          isStatusNotice: true,
        },
      };
    }
  }
  const sessionAgentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : (params.agentId ?? "main");
  const currentAgentId = params.agentId ?? "main";
  const sessionAgentDir =
    sessionAgentId === currentAgentId && params.agentDir
      ? params.agentDir
      : resolveAgentDir(params.cfg, sessionAgentId);
  const customInstructions = extractCompactInstructions({
    rawBody: params.ctx.commandText,
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: sessionAgentId,
    isGroup: params.isGroup,
  });
  const contextTokenBudget = resolveManualCompactContextTokenBudget({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    liveContextTokens: params.contextTokens,
    persistedContextTokens: targetSessionEntry.contextTokens,
  });
  const selectedRuntime = resolveSessionRuntimeOverrideForProvider({
    provider: params.provider,
    entry: targetSessionEntry,
  });
  const compactionStorePath = resolveSessionStorePathForScope({
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    storePath:
      params.storePath ?? resolveStorePath(params.cfg.session?.store, { agentId: sessionAgentId }),
  });
  const result = await runtime.compactEmbeddedAgentSession({
    abortSignal: params.opts?.abortSignal,
    sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: {
      agentId: sessionAgentId,
      sessionId,
      sessionKey: params.sessionKey,
      storePath: compactionStorePath,
    },
    allowGatewaySubagentBinding: true,
    messageChannel: params.command.channel,
    clientCaps: params.ctx.GatewayClientCaps,
    conversationToolPolicy: params.ctx.ConversationToolPolicy,
    groupId: targetSessionEntry.groupId,
    groupChannel: targetSessionEntry.groupChannel,
    groupSpace: targetSessionEntry.space,
    spawnedBy: targetSessionEntry.spawnedBy,
    senderId: params.command.senderId,
    senderName: params.ctx.SenderName,
    senderUsername: params.ctx.SenderUsername,
    senderE164: params.ctx.SenderE164,
    inputProvenance: params.ctx.InputProvenance,
    sessionFile: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: sessionAgentDir,
    config: params.cfg,
    skillsSnapshot: targetSessionEntry.skillsSnapshot,
    provider: params.provider,
    model: params.model,
    authProfileId: targetSessionEntry.authProfileOverride,
    authProfileIdSource: resolveSessionAuthProfileOverrideSource(targetSessionEntry),
    contextTokenBudget,
    agentHarnessId:
      targetSessionEntry.modelSelectionLocked === true
        ? resolvePersistedSessionRuntimeId(targetSessionEntry)
        : (selectedRuntime ??
          (targetSessionEntry.agentRuntimeOverride
            ? undefined
            : targetSessionEntry.agentHarnessId)),
    modelSelectionLocked: targetSessionEntry.modelSelectionLocked === true,
    thinkLevel: params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel()),
    bashElevated: {
      enabled: false,
      allowed: false,
      defaultLevel: "off",
    },
    customInstructions,
    trigger: "manual",
    ownerNumbers: resolveOwnerPromptNumbers({
      ownerNumbers: params.command.ownerList,
      senderId: params.command.senderId,
      senderIsOwner: params.command.senderIsOwner,
    }),
  });

  const tokensAfterCompaction = result.result?.tokensAfter;
  const didCompact = result.ok && result.compacted;
  const compactLabel =
    result.ok || isBenignCompactionSkipResult(result)
      ? didCompact
        ? typeof tokensAfterCompaction !== "number"
          ? "Compaction finished (resulting context unknown)"
          : result.result?.tokensBefore != null
            ? `Compacted (${runtime.formatTokenCount(result.result.tokensBefore)} → ${runtime.formatTokenCount(tokensAfterCompaction)})`
            : "Compacted"
        : "Compaction skipped"
      : "Compaction failed";
  if (didCompact) {
    await runtime.incrementCompactionCount({
      agentId: sessionAgentId,
      cfg: params.cfg,
      sessionEntry: targetSessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: compactionStorePath,
      // Update token counts after compaction
      tokensAfter: result.result?.tokensAfter,
      newSessionId: result.result?.sessionId,
    });
  }
  // Use the post-compaction token count for context summary if available
  const totalTokens = didCompact
    ? tokensAfterCompaction
    : runtime.resolveFreshSessionTotalTokens(targetSessionEntry);
  const contextSummary = runtime.formatContextUsageShort(
    typeof totalTokens === "number" && totalTokens > 0 ? totalTokens : null,
    contextTokenBudget ?? null,
  );
  const reason = formatCompactionReason(result.reason);
  const line = reason
    ? `${compactLabel}: ${reason} • ${contextSummary}`
    : `${compactLabel} • ${contextSummary}`;
  runtime.enqueueSystemEvent(line, { sessionKey: params.sessionKey });
  return {
    shouldContinue: false,
    reply: {
      text: `⚙️ ${line}`,
      isStatusNotice: true,
    },
  };
};
