// Implements compaction commands for session context and model state.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
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
import { resolveManualCompactionCliTarget } from "../../agents/session-runtime-compat.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";
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
  if (classification === "no_compactable_entries") {
    return "nothing compactable in this session yet";
  }
  if (classification === "already_compacted") {
    return "session is already compacted";
  }
  return classification === "below_threshold"
    ? normalizeLowercaseStringOrEmpty(reason).includes("already under target")
      ? "context is already under the compaction target"
      : "context is below the compaction threshold"
    : text;
}

function compactionUnavailable(reason: string, text: string): CommandHandlerResult {
  return {
    shouldContinue: false,
    sessionCompaction: { compacted: false, reason },
    reply: { text, isStatusNotice: true },
  };
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
  const liveContextTokens = inheritedContextTokens;

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
  const unauthorized = rejectUnauthorizedCommand(params, "/compact");
  if (unauthorized) {
    return unauthorized;
  }
  const targetSessionEntry = params.commandInvocationSignal
    ? params.compactionSessionEntry
    : (params.sessionStore?.[params.sessionKey] ?? params.sessionEntry);
  if (!targetSessionEntry?.sessionId) {
    return compactionUnavailable(
      "missing session id",
      "⚙️ Compaction unavailable (missing session id).",
    );
  }
  const runtime = await loadCompactRuntime();
  const sessionId = targetSessionEntry.sessionId;
  const sessionAgentId = params.sessionKey
    ? resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: params.cfg,
        agentId: params.agentId,
      })
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
  const compactionStorePath = resolveSessionStorePathForScope({
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    storePath:
      params.storePath ??
      resolveSessionStorePathCore(params.cfg.session?.store, { agentId: sessionAgentId }),
  });
  let expectedSession: InternalSessionEntry = targetSessionEntry;
  const resolveCurrentEntry = () =>
    runtime.resolveCurrentSessionEntry({
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      storePath: compactionStorePath,
      expected: expectedSession,
    });
  const authorityFailure = () => {
    const reason =
      params.commandInvocationSignal?.aborted || params.opts?.abortSignal?.aborted
        ? "command invocation closed"
        : !resolveCurrentEntry()
          ? "command session changed"
          : undefined;
    return reason
      ? compactionUnavailable(reason, `⚙️ Compaction unavailable: ${reason}.`)
      : undefined;
  };
  let failure = authorityFailure();
  if (failure) {
    return failure;
  }
  if (runtime.isEmbeddedAgentRunAbortableForCompaction(sessionId)) {
    runtime.abortEmbeddedAgentRun(sessionId);
    const drained = await runtime.waitForEmbeddedAgentRunEnd(sessionId, 15_000);
    failure = authorityFailure();
    if (failure) {
      return failure;
    }
    if (!drained) {
      return compactionUnavailable(
        "the previous run is still stopping",
        "⚙️ Compaction unavailable: the previous run is still stopping.",
      );
    }
  }
  const thinkLevel = params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel());
  failure = authorityFailure();
  if (failure) {
    return failure;
  }
  // Draining a run does not clear its durable writer fence. Capture the current
  // row after the drain instead of accounting against the command's older snapshot.
  const refreshedEntry = resolveCurrentEntry();
  if (!refreshedEntry) {
    return compactionUnavailable(
      "command session changed",
      "⚙️ Compaction unavailable: command session changed.",
    );
  }
  expectedSession = refreshedEntry;
  if (params.sessionStore) {
    params.sessionStore[params.sessionKey] = refreshedEntry;
  }
  const compactionCliTarget = resolveManualCompactionCliTarget({
    provider: params.provider,
    entry: refreshedEntry,
    cfg: params.cfg,
  });
  const replyOperation = params.opts?.replyOperation;
  replyOperation?.setPhase("preflight_compacting");
  const compaction = runtime.compactEmbeddedAgentSession(
    {
      abortSignal: params.opts?.abortSignal,
      contextEngineAgentId: sessionAgentId,
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
      groupId: expectedSession.groupId,
      groupChannel: expectedSession.groupChannel,
      groupSpace: expectedSession.space,
      spawnedBy: expectedSession.spawnedBy,
      senderId: params.command.senderId,
      senderName: params.ctx.SenderName,
      senderUsername: params.ctx.SenderUsername,
      senderE164: params.ctx.SenderE164,
      inputProvenance: params.ctx.InputProvenance,
      sessionFile: params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: sessionAgentDir,
      config: params.cfg,
      // Group session keys carry no account identity, so without this manual
      // /compact resolves the root history limit while prompt preparation used the
      // account limit.
      agentAccountId: params.ctx.AccountId,
      conversationRoutePeerId: params.ctx.ConversationRoutePeerId,
      chatType: normalizeChatType(params.ctx.ChatType),
      skillsSnapshot: expectedSession.skillsSnapshot,
      provider: params.provider,
      model: params.model,
      authProfileId:
        compactionCliTarget.cliSessionBinding?.authProfileId ?? expectedSession.authProfileOverride,
      authProfileIdSource: resolveCollapsedSessionAuthPinSource(expectedSession),
      contextTokenBudget,
      agentHarnessId: compactionCliTarget.agentHarnessId,
      cliSessionId: compactionCliTarget.cliSessionId,
      cliSessionBinding: compactionCliTarget.cliSessionBinding,
      sessionEntry: expectedSession,
      modelSelectionLocked: expectedSession.modelSelectionLocked === true,
      thinkLevel,
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
    },
    {
      assertActive: () => {
        params.opts?.abortSignal?.throwIfAborted();
        params.commandInvocationSignal?.throwIfAborted();
        const current = resolveCurrentEntry();
        if (!current || current.activeWriterRunId !== expectedSession.activeWriterRunId) {
          throw new Error("command session changed");
        }
      },
      onCommitted: (accepted) => {
        // Update the expectation before identity observers run, not from public result metadata.
        expectedSession = accepted.entry;
        if (params.sessionStore) {
          params.sessionStore[params.sessionKey] = accepted.entry;
        }
      },
    },
  );
  const result = await compaction.finally(() => replyOperation?.setPhase("running"));

  const tokensAfterCompaction = result.result?.tokensAfter;
  const didCompact = result.ok && result.compacted;
  const compactLabel =
    result.ok || isBenignCompactionSkipResult(result)
      ? didCompact
        ? result.compactionKind === "server-endpoint" &&
          typeof tokensAfterCompaction === "number" &&
          result.result?.tokensBefore != null
          ? `Server-side compaction (${runtime.formatTokenCount(result.result.tokensBefore)} → ${runtime.formatTokenCount(tokensAfterCompaction)})`
          : typeof tokensAfterCompaction !== "number"
            ? "Compaction finished (resulting context unknown)"
            : result.result?.tokensBefore != null
              ? `Compacted (${runtime.formatTokenCount(result.result.tokensBefore)} → ${runtime.formatTokenCount(tokensAfterCompaction)})`
              : "Compacted"
        : "Compaction skipped"
      : "Compaction failed";
  if (didCompact) {
    const compactionCount = await runtime.incrementCompactionCount({
      agentId: sessionAgentId,
      sessionEntry: expectedSession,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: compactionStorePath,
      tokensAfter: result.result?.tokensAfter,
      compactionKind: result.compactionKind,
      expectedSession,
    });
    if (compactionCount === undefined) {
      return (
        authorityFailure() ??
        compactionUnavailable(
          "session accounting failed",
          "⚙️ Compaction unavailable: session accounting failed.",
        )
      );
    }
  }
  failure = authorityFailure();
  if (failure) {
    return failure;
  }
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
    sessionCompaction: {
      compacted: didCompact,
      reason: result.reason,
      tokensBefore: result.result?.tokensBefore,
      tokensAfter: tokensAfterCompaction,
    },
    reply: {
      text: `⚙️ ${line}`,
      isStatusNotice: true,
    },
  };
};
