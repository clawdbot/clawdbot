import {
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "../../agents/auth-profiles.js";
import {
  getCustomProviderApiKey,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
import {
  abortEmbeddedPiRun,
  compactEmbeddedPiSession,
  isEmbeddedPiRunActive,
  waitForEmbeddedPiRunEnd,
} from "../../agents/pi-embedded.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  resolveSessionFilePath,
  type SessionEntry,
  type SessionScope,
  saveSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import {
  formatUsageSummaryLine,
  loadProviderUsageSummary,
} from "../../infra/provider-usage.js";
import {
  scheduleGatewaySigusr1Restart,
  triggerClawdbotRestart,
} from "../../infra/restart.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { normalizeE164 } from "../../utils.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import {
  normalizeCommandBody,
  shouldHandleTextCommands,
} from "../commands-registry.js";
import {
  normalizeGroupActivation,
  parseActivationCommand,
} from "../group-activation.js";
import { parseSendPolicyCommand } from "../send-policy.js";
import {
  buildHelpMessage,
  buildStatusMessage,
  formatContextUsageShort,
  formatTokenCount,
} from "../status.js";
import type { MsgContext } from "../templating.js";
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { isAbortTrigger, setAbortMemory } from "./abort.js";
import type { InlineDirectives } from "./directive-handling.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { getFollowupQueueDepth, resolveQueueSettings } from "./queue.js";
import { incrementCompactionCount } from "./session-updates.js";

function resolveSessionEntryForKey(
  store: Record<string, SessionEntry> | undefined,
  sessionKey: string | undefined,
) {
  if (!store || !sessionKey) return {};
  const direct = store[sessionKey];
  if (direct) return { entry: direct, key: sessionKey };
  const parsed = parseAgentSessionKey(sessionKey);
  const legacyKey = parsed?.rest;
  if (legacyKey && store[legacyKey]) {
    return { entry: store[legacyKey], key: legacyKey };
  }
  return {};
}

export type CommandContext = {
  surface: string;
  provider: string;
  isWhatsAppProvider: boolean;
  ownerList: string[];
  isAuthorizedSender: boolean;
  senderE164?: string;
  abortKey?: string;
  rawBodyNormalized: string;
  commandBodyNormalized: string;
  from?: string;
  to?: string;
};

function resolveModelAuthLabel(
  provider?: string,
  cfg?: ClawdbotConfig,
): string | undefined {
  const resolved = provider?.trim();
  if (!resolved) return undefined;

  const store = ensureAuthProfileStore();
  const profiles = listProfilesForProvider(store, resolved);
  if (profiles.length > 0) {
    const modes = new Set(
      profiles
        .map((id) => store.profiles[id]?.type)
        .filter((mode): mode is "api_key" | "oauth" => Boolean(mode)),
    );
    if (modes.has("oauth") && modes.has("api_key")) return "mixed";
    if (modes.has("oauth")) return "oauth";
    if (modes.has("api_key")) return "api-key";
  }

  const envKey = resolveEnvApiKey(resolved);
  if (envKey?.apiKey) {
    return envKey.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
  }

  if (getCustomProviderApiKey(cfg, resolved)) return "api-key";

  return "unknown";
}

function extractCompactInstructions(params: {
  rawBody?: string;
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  isGroup: boolean;
}): string | undefined {
  const raw = stripStructuralPrefixes(params.rawBody ?? "");
  const stripped = params.isGroup
    ? stripMentions(raw, params.ctx, params.cfg)
    : raw;
  const trimmed = stripped.trim();
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  const prefix = lowered.startsWith("/compact") ? "/compact" : null;
  if (!prefix) return undefined;
  let rest = trimmed.slice(prefix.length).trimStart();
  if (rest.startsWith(":")) rest = rest.slice(1).trimStart();
  return rest.length ? rest : undefined;
}

export function buildCommandContext(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  sessionKey?: string;
  isGroup: boolean;
  triggerBodyNormalized: string;
  commandAuthorized: boolean;
}): CommandContext {
  const { ctx, cfg, sessionKey, isGroup, triggerBodyNormalized } = params;
  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized: params.commandAuthorized,
  });
  const surface = (ctx.Surface ?? ctx.Provider ?? "").trim().toLowerCase();
  const provider = (ctx.Provider ?? surface).trim().toLowerCase();
  const abortKey =
    sessionKey ?? (auth.from || undefined) ?? (auth.to || undefined);
  const rawBodyNormalized = triggerBodyNormalized;
  const commandBodyNormalized = normalizeCommandBody(
    isGroup ? stripMentions(rawBodyNormalized, ctx, cfg) : rawBodyNormalized,
  );

  return {
    surface,
    provider,
    isWhatsAppProvider: auth.isWhatsAppProvider,
    ownerList: auth.ownerList,
    isAuthorizedSender: auth.isAuthorizedSender,
    senderE164: auth.senderE164,
    abortKey,
    rawBodyNormalized,
    commandBodyNormalized,
    from: auth.from,
    to: auth.to,
  };
}

function resolveAbortTarget(params: {
  ctx: MsgContext;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
}) {
  const targetSessionKey =
    params.ctx.CommandTargetSessionKey?.trim() || params.sessionKey;
  const { entry, key } = resolveSessionEntryForKey(
    params.sessionStore,
    targetSessionKey,
  );
  if (entry && key) return { entry, key, sessionId: entry.sessionId };
  if (params.sessionEntry && params.sessionKey) {
    return {
      entry: params.sessionEntry,
      key: params.sessionKey,
      sessionId: params.sessionEntry.sessionId,
    };
  }
  return { entry: undefined, key: targetSessionKey, sessionId: undefined };
}

export async function handleCommands(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  command: CommandContext;
  directives: InlineDirectives;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  sessionScope?: SessionScope;
  workspaceDir: string;
  defaultGroupActivation: () => "always" | "mention";
  resolvedThinkLevel?: ThinkLevel;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  provider: string;
  model: string;
  contextTokens: number;
  isGroup: boolean;
}): Promise<{
  reply?: ReplyPayload;
  shouldContinue: boolean;
}> {
  const {
    ctx,
    cfg,
    command,
    directives,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    defaultGroupActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    isGroup,
  } = params;

  const resetRequested =
    command.commandBodyNormalized === "/reset" ||
    command.commandBodyNormalized === "/new";
  if (resetRequested && !command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /reset from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const activationCommand = parseActivationCommand(
    command.commandBodyNormalized,
  );
  const sendPolicyCommand = parseSendPolicyCommand(
    command.commandBodyNormalized,
  );
  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: command.surface,
    commandSource: ctx.CommandSource,
  });

  if (allowTextCommands && activationCommand.hasCommand) {
    if (!isGroup) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Group activation only applies to group chats." },
      };
    }
    const activationOwnerList = command.ownerList;
    const activationSenderE164 = command.senderE164
      ? normalizeE164(command.senderE164)
      : "";
    const isActivationOwner =
      !command.isWhatsAppProvider || activationOwnerList.length === 0
        ? command.isAuthorizedSender
        : Boolean(activationSenderE164) &&
          activationOwnerList.includes(activationSenderE164);

    if (
      !command.isAuthorizedSender ||
      (command.isWhatsAppProvider && !isActivationOwner)
    ) {
      logVerbose(
        `Ignoring /activation from unauthorized sender in group: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (!activationCommand.mode) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Usage: /activation mention|always" },
      };
    }
    if (sessionEntry && sessionStore && sessionKey) {
      sessionEntry.groupActivation = activationCommand.mode;
      sessionEntry.groupActivationNeedsSystemIntro = true;
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    }
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Group activation set to ${activationCommand.mode}.` },
    };
  }

  if (allowTextCommands && sendPolicyCommand.hasCommand) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /send from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (!sendPolicyCommand.mode) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Usage: /send on|off|inherit" },
      };
    }
    if (sessionEntry && sessionStore && sessionKey) {
      if (sendPolicyCommand.mode === "inherit") {
        delete sessionEntry.sendPolicy;
      } else {
        sessionEntry.sendPolicy = sendPolicyCommand.mode;
      }
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    }
    const label =
      sendPolicyCommand.mode === "inherit"
        ? "inherit"
        : sendPolicyCommand.mode === "allow"
          ? "on"
          : "off";
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Send policy set to ${label}.` },
    };
  }

  if (allowTextCommands && command.commandBodyNormalized === "/restart") {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /restart from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    const hasSigusr1Listener = process.listenerCount("SIGUSR1") > 0;
    if (hasSigusr1Listener) {
      scheduleGatewaySigusr1Restart({ reason: "/restart" });
      return {
        shouldContinue: false,
        reply: {
          text: "⚙️ Restarting clawdbot in-process (SIGUSR1); back in a few seconds.",
        },
      };
    }
    const restartMethod = triggerClawdbotRestart();
    if (!restartMethod.ok) {
      const detail = restartMethod.detail
        ? ` Details: ${restartMethod.detail}`
        : "";
      return {
        shouldContinue: false,
        reply: {
          text: `⚠️ Restart failed (${restartMethod.method}).${detail}`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: {
        text: `⚙️ Restarting clawdbot via ${restartMethod.method}; give me a few seconds to come back online.`,
      },
    };
  }

  const helpRequested = command.commandBodyNormalized === "/help";
  if (allowTextCommands && helpRequested) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /help from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    return { shouldContinue: false, reply: { text: buildHelpMessage() } };
  }

  const statusRequested =
    directives.hasStatusDirective ||
    command.commandBodyNormalized === "/status";
  if (allowTextCommands && statusRequested) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /status from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    let usageLine: string | null = null;
    try {
      const usageSummary = await loadProviderUsageSummary({
        timeoutMs: 3500,
      });
      usageLine = formatUsageSummaryLine(usageSummary, { now: Date.now() });
    } catch {
      usageLine = null;
    }
    const queueSettings = resolveQueueSettings({
      cfg,
      provider: command.provider,
      sessionEntry,
    });
    const queueKey = sessionKey ?? sessionEntry?.sessionId;
    const queueDepth = queueKey ? getFollowupQueueDepth(queueKey) : 0;
    const queueOverrides = Boolean(
      sessionEntry?.queueDebounceMs ??
        sessionEntry?.queueCap ??
        sessionEntry?.queueDrop,
    );
    const groupActivation = isGroup
      ? (normalizeGroupActivation(sessionEntry?.groupActivation) ??
        defaultGroupActivation())
      : undefined;
    const statusText = buildStatusMessage({
      agent: {
        ...cfg.agent,
        model: {
          ...cfg.agent?.model,
          primary: model,
        },
        contextTokens,
        thinkingDefault: cfg.agent?.thinkingDefault,
        verboseDefault: cfg.agent?.verboseDefault,
        elevatedDefault: cfg.agent?.elevatedDefault,
      },
      sessionEntry,
      sessionKey,
      sessionScope,
      groupActivation,
      resolvedThink:
        resolvedThinkLevel ?? (await resolveDefaultThinkingLevel()),
      resolvedVerbose: resolvedVerboseLevel,
      resolvedReasoning: resolvedReasoningLevel,
      resolvedElevated: resolvedElevatedLevel,
      modelAuth: resolveModelAuthLabel(provider, cfg),
      usageLine: usageLine ?? undefined,
      queue: {
        mode: queueSettings.mode,
        depth: queueDepth,
        debounceMs: queueSettings.debounceMs,
        cap: queueSettings.cap,
        dropPolicy: queueSettings.dropPolicy,
        showDetails: queueOverrides,
      },
      includeTranscriptUsage: false,
    });
    return { shouldContinue: false, reply: { text: statusText } };
  }

  const stopRequested = command.commandBodyNormalized === "/stop";
  if (allowTextCommands && stopRequested) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /stop from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    const abortTarget = resolveAbortTarget({
      ctx,
      sessionKey,
      sessionEntry,
      sessionStore,
    });
    if (abortTarget.sessionId) {
      abortEmbeddedPiRun(abortTarget.sessionId);
    }
    if (abortTarget.entry && sessionStore && abortTarget.key) {
      abortTarget.entry.abortedLastRun = true;
      abortTarget.entry.updatedAt = Date.now();
      sessionStore[abortTarget.key] = abortTarget.entry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    } else if (command.abortKey) {
      setAbortMemory(command.abortKey, true);
    }
    return { shouldContinue: false, reply: { text: "⚙️ Agent was aborted." } };
  }

  const compactRequested =
    command.commandBodyNormalized === "/compact" ||
    command.commandBodyNormalized.startsWith("/compact ");
  if (compactRequested) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /compact from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (!sessionEntry?.sessionId) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Compaction unavailable (missing session id)." },
      };
    }
    const sessionId = sessionEntry.sessionId;
    if (isEmbeddedPiRunActive(sessionId)) {
      abortEmbeddedPiRun(sessionId);
      await waitForEmbeddedPiRunEnd(sessionId, 15_000);
    }
    const customInstructions = extractCompactInstructions({
      rawBody: ctx.Body,
      ctx,
      cfg,
      isGroup,
    });
    const result = await compactEmbeddedPiSession({
      sessionId,
      sessionKey,
      messageProvider: command.provider,
      sessionFile: resolveSessionFilePath(sessionId, sessionEntry),
      workspaceDir,
      config: cfg,
      skillsSnapshot: sessionEntry.skillsSnapshot,
      provider,
      model,
      thinkLevel: resolvedThinkLevel ?? (await resolveDefaultThinkingLevel()),
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      customInstructions,
      ownerNumbers:
        command.ownerList.length > 0 ? command.ownerList : undefined,
    });

    const totalTokens =
      sessionEntry.totalTokens ??
      (sessionEntry.inputTokens ?? 0) + (sessionEntry.outputTokens ?? 0);
    const contextSummary = formatContextUsageShort(
      totalTokens > 0 ? totalTokens : null,
      contextTokens ?? sessionEntry.contextTokens ?? null,
    );
    const compactLabel = result.ok
      ? result.compacted
        ? result.result?.tokensBefore
          ? `Compacted (${formatTokenCount(result.result.tokensBefore)} before)`
          : "Compacted"
        : "Compaction skipped"
      : "Compaction failed";
    if (result.ok && result.compacted) {
      await incrementCompactionCount({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
    }
    const reason = result.reason?.trim();
    const line = reason
      ? `${compactLabel}: ${reason} • ${contextSummary}`
      : `${compactLabel} • ${contextSummary}`;
    enqueueSystemEvent(line);
    return { shouldContinue: false, reply: { text: `⚙️ ${line}` } };
  }

  const abortRequested = isAbortTrigger(command.rawBodyNormalized);
  if (allowTextCommands && abortRequested) {
    const abortTarget = resolveAbortTarget({
      ctx,
      sessionKey,
      sessionEntry,
      sessionStore,
    });
    if (abortTarget.sessionId) {
      abortEmbeddedPiRun(abortTarget.sessionId);
    }
    if (abortTarget.entry && sessionStore && abortTarget.key) {
      abortTarget.entry.abortedLastRun = true;
      abortTarget.entry.updatedAt = Date.now();
      sessionStore[abortTarget.key] = abortTarget.entry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    } else if (command.abortKey) {
      setAbortMemory(command.abortKey, true);
    }
    return { shouldContinue: false, reply: { text: "⚙️ Agent was aborted." } };
  }

  const sendPolicy = resolveSendPolicy({
    cfg,
    entry: sessionEntry,
    sessionKey,
    provider: sessionEntry?.provider ?? command.provider,
    chatType: sessionEntry?.chatType,
  });
  if (sendPolicy === "deny") {
    logVerbose(`Send blocked by policy for session ${sessionKey ?? "unknown"}`);
    return { shouldContinue: false };
  }

  return { shouldContinue: true };
}
