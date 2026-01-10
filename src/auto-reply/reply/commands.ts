import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import {
  ensureAuthProfileStore,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import {
  getCustomProviderApiKey,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import {
  abortEmbeddedPiRun,
  compactEmbeddedPiSession,
  isEmbeddedPiRunActive,
  waitForEmbeddedPiRunEnd,
} from "../../agents/pi-embedded.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  readConfigFileSnapshot,
  validateConfigObject,
  writeConfigFile,
} from "../../config/config.js";
import {
  getConfigValueAtPath,
  parseConfigPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "../../config/config-paths.js";
import {
  getConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
  unsetConfigOverride,
} from "../../config/runtime-overrides.js";
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
  resolveUsageProviderId,
} from "../../infra/provider-usage.js";
import {
  scheduleGatewaySigusr1Restart,
  triggerClawdbotRestart,
} from "../../infra/restart.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { ProviderId } from "../../providers/plugins/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
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
  buildCommandsMessage,
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
import { parseConfigCommand } from "./config-commands.js";
import { parseDebugCommand } from "./debug-commands.js";
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
  providerId?: ProviderId;
  ownerList: string[];
  isAuthorizedSender: boolean;
  senderId?: string;
  abortKey?: string;
  rawBodyNormalized: string;
  commandBodyNormalized: string;
  from?: string;
  to?: string;
};

export async function buildStatusReply(params: {
  cfg: ClawdbotConfig;
  command: CommandContext;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  sessionScope?: SessionScope;
  provider: string;
  model: string;
  contextTokens: number;
  resolvedThinkLevel?: ThinkLevel;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
}): Promise<ReplyPayload | undefined> {
  const {
    cfg,
    command,
    sessionEntry,
    sessionKey,
    sessionScope,
    provider,
    model,
    contextTokens,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    isGroup,
    defaultGroupActivation,
  } = params;
  if (!command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /status from unauthorized sender: ${command.senderId || "<unknown>"}`,
    );
    return undefined;
  }
  const statusAgentId = sessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const statusAgentDir = resolveAgentDir(cfg, statusAgentId);
  let usageLine: string | null = null;
  try {
    const usageProvider = resolveUsageProviderId(provider);
    if (usageProvider) {
      const usageSummary = await loadProviderUsageSummary({
        timeoutMs: 3500,
        providers: [usageProvider],
        agentDir: statusAgentDir,
      });
      usageLine = formatUsageSummaryLine(usageSummary, { now: Date.now() });
      if (
        !usageLine &&
        (resolvedVerboseLevel === "on" || resolvedElevatedLevel === "on")
      ) {
        const entry = usageSummary.providers[0];
        if (entry?.error) {
          usageLine = `📊 Usage: ${entry.displayName} (${entry.error})`;
        }
      }
    }
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
  const agentDefaults = cfg.agents?.defaults ?? {};
  const statusText = buildStatusMessage({
    config: cfg,
    agent: {
      ...agentDefaults,
      model: {
        ...agentDefaults.model,
        primary: `${provider}/${model}`,
      },
      contextTokens,
      thinkingDefault: agentDefaults.thinkingDefault,
      verboseDefault: agentDefaults.verboseDefault,
      elevatedDefault: agentDefaults.elevatedDefault,
    },
    sessionEntry,
    sessionKey,
    sessionScope,
    groupActivation,
    resolvedThink: resolvedThinkLevel ?? (await resolveDefaultThinkingLevel()),
    resolvedVerbose: resolvedVerboseLevel,
    resolvedReasoning: resolvedReasoningLevel,
    resolvedElevated: resolvedElevatedLevel,
    modelAuth: resolveModelAuthLabel(
      provider,
      cfg,
      sessionEntry,
      statusAgentDir,
    ),
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
  return { text: statusText };
}

function formatApiKeySnippet(apiKey: string): string {
  const compact = apiKey.replace(/\s+/g, "");
  if (!compact) return "unknown";
  const edge = compact.length >= 12 ? 6 : 4;
  const head = compact.slice(0, edge);
  const tail = compact.slice(-edge);
  return `${head}…${tail}`;
}

function resolveModelAuthLabel(
  provider?: string,
  cfg?: ClawdbotConfig,
  sessionEntry?: SessionEntry,
  agentDir?: string,
): string | undefined {
  const resolved = provider?.trim();
  if (!resolved) return undefined;

  const providerKey = normalizeProviderId(resolved);
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const profileOverride = sessionEntry?.authProfileOverride?.trim();
  const order = resolveAuthProfileOrder({
    cfg,
    store,
    provider: providerKey,
    preferredProfile: profileOverride,
  });
  const candidates = [profileOverride, ...order].filter(Boolean) as string[];

  for (const profileId of candidates) {
    const profile = store.profiles[profileId];
    if (!profile || normalizeProviderId(profile.provider) !== providerKey) {
      continue;
    }
    const label = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
    if (profile.type === "oauth") {
      return `oauth${label ? ` (${label})` : ""}`;
    }
    if (profile.type === "token") {
      const snippet = formatApiKeySnippet(profile.token);
      return `token ${snippet}${label ? ` (${label})` : ""}`;
    }
    const snippet = formatApiKeySnippet(profile.key);
    return `api-key ${snippet}${label ? ` (${label})` : ""}`;
  }

  const envKey = resolveEnvApiKey(providerKey);
  if (envKey?.apiKey) {
    if (envKey.source.includes("OAUTH_TOKEN")) {
      return `oauth (${envKey.source})`;
    }
    return `api-key ${formatApiKeySnippet(envKey.apiKey)} (${envKey.source})`;
  }

  const customKey = getCustomProviderApiKey(cfg, providerKey);
  if (customKey) {
    return `api-key ${formatApiKeySnippet(customKey)} (models.json)`;
  }

  return "unknown";
}

function extractCompactInstructions(params: {
  rawBody?: string;
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  agentId?: string;
  isGroup: boolean;
}): string | undefined {
  const raw = stripStructuralPrefixes(params.rawBody ?? "");
  const stripped = params.isGroup
    ? stripMentions(raw, params.ctx, params.cfg, params.agentId)
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
  agentId?: string;
  sessionKey?: string;
  isGroup: boolean;
  triggerBodyNormalized: string;
  commandAuthorized: boolean;
}): CommandContext {
  const { ctx, cfg, agentId, sessionKey, isGroup, triggerBodyNormalized } =
    params;
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
    isGroup
      ? stripMentions(rawBodyNormalized, ctx, cfg, agentId)
      : rawBodyNormalized,
  );

  return {
    surface,
    provider,
    providerId: auth.providerId,
    ownerList: auth.ownerList,
    isAuthorizedSender: auth.isAuthorizedSender,
    senderId: auth.senderId,
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
  agentId?: string;
  directives: InlineDirectives;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
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
      `Ignoring /reset from unauthorized sender: ${command.senderId || "<unknown>"}`,
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
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /activation from unauthorized sender in group: ${command.senderId || "<unknown>"}`,
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
        `Ignoring /send from unauthorized sender: ${command.senderId || "<unknown>"}`,
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
        `Ignoring /restart from unauthorized sender: ${command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (cfg.commands?.restart !== true) {
      return {
        shouldContinue: false,
        reply: {
          text: "⚠️ /restart is disabled. Set commands.restart=true to enable.",
        },
      };
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
        `Ignoring /help from unauthorized sender: ${command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    return { shouldContinue: false, reply: { text: buildHelpMessage(cfg) } };
  }

  const commandsRequested = command.commandBodyNormalized === "/commands";
  if (allowTextCommands && commandsRequested) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /commands from unauthorized sender: ${command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    return {
      shouldContinue: false,
      reply: { text: buildCommandsMessage(cfg) },
    };
  }

  const statusRequested =
    directives.hasStatusDirective ||
    command.commandBodyNormalized === "/status";
  if (allowTextCommands && statusRequested) {
    const reply = await buildStatusReply({
      cfg,
      command,
      sessionEntry,
      sessionKey,
      sessionScope,
      provider,
      model,
      contextTokens,
      resolvedThinkLevel,
      resolvedVerboseLevel,
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      resolveDefaultThinkingLevel,
      isGroup,
      defaultGroupActivation,
    });
    return { shouldContinue: false, reply };
  }

  const whoamiRequested = command.commandBodyNormalized === "/whoami";
  if (allowTextCommands && whoamiRequested) {
    const senderId = ctx.SenderId ?? "";
    const senderUsername = ctx.SenderUsername ?? "";
    const lines = ["🧭 Identity", `Provider: ${command.provider}`];
    if (senderId) lines.push(`User id: ${senderId}`);
    if (senderUsername) {
      const handle = senderUsername.startsWith("@")
        ? senderUsername
        : `@${senderUsername}`;
      lines.push(`Username: ${handle}`);
    }
    if (ctx.ChatType === "group" && ctx.From) {
      lines.push(`Chat: ${ctx.From}`);
    }
    if (ctx.MessageThreadId != null) {
      lines.push(`Thread: ${ctx.MessageThreadId}`);
    }
    if (senderId) {
      lines.push(`AllowFrom: ${senderId}`);
    }
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  const configCommand = allowTextCommands
    ? parseConfigCommand(command.commandBodyNormalized)
    : null;
  if (configCommand) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /config from unauthorized sender: ${command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (cfg.commands?.config !== true) {
      return {
        shouldContinue: false,
        reply: {
          text: "⚠️ /config is disabled. Set commands.config=true to enable.",
        },
      };
    }
    if (configCommand.action === "error") {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${configCommand.message}` },
      };
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
      return {
        shouldContinue: false,
        reply: { text: "⚠️ Config file is invalid; fix it before using /config." },
      };
    }
    const parsedBase = structuredClone(
      snapshot.parsed as Record<string, unknown>,
    );

    if (configCommand.action === "show") {
      const pathRaw = configCommand.path?.trim();
      if (pathRaw) {
        const parsedPath = parseConfigPath(pathRaw);
        if (!parsedPath.ok || !parsedPath.path) {
          return {
            shouldContinue: false,
            reply: { text: `⚠️ ${parsedPath.error ?? "Invalid path."}` },
          };
        }
        const value = getConfigValueAtPath(parsedBase, parsedPath.path);
        const rendered = JSON.stringify(value ?? null, null, 2);
        return {
          shouldContinue: false,
          reply: {
            text: `⚙️ Config ${pathRaw}:\n\`\`\`json\n${rendered}\n\`\`\``,
          },
        };
      }
      const json = JSON.stringify(parsedBase, null, 2);
      return {
        shouldContinue: false,
        reply: { text: `⚙️ Config (raw):\n\`\`\`json\n${json}\n\`\`\`` },
      };
    }

    if (configCommand.action === "unset") {
      const parsedPath = parseConfigPath(configCommand.path);
      if (!parsedPath.ok || !parsedPath.path) {
        return {
          shouldContinue: false,
          reply: { text: `⚠️ ${parsedPath.error ?? "Invalid path."}` },
        };
      }
      const removed = unsetConfigValueAtPath(parsedBase, parsedPath.path);
      if (!removed) {
        return {
          shouldContinue: false,
          reply: { text: `⚙️ No config value found for ${configCommand.path}.` },
        };
      }
      const validated = validateConfigObject(parsedBase);
      if (!validated.ok) {
        const issue = validated.issues[0];
        return {
          shouldContinue: false,
          reply: {
            text: `⚠️ Config invalid after unset (${issue.path}: ${issue.message}).`,
          },
        };
      }
      await writeConfigFile(validated.config);
      return {
        shouldContinue: false,
        reply: { text: `⚙️ Config updated: ${configCommand.path} removed.` },
      };
    }

    if (configCommand.action === "set") {
      const parsedPath = parseConfigPath(configCommand.path);
      if (!parsedPath.ok || !parsedPath.path) {
        return {
          shouldContinue: false,
          reply: { text: `⚠️ ${parsedPath.error ?? "Invalid path."}` },
        };
      }
      setConfigValueAtPath(parsedBase, parsedPath.path, configCommand.value);
      const validated = validateConfigObject(parsedBase);
      if (!validated.ok) {
        const issue = validated.issues[0];
        return {
          shouldContinue: false,
          reply: {
            text: `⚠️ Config invalid after set (${issue.path}: ${issue.message}).`,
          },
        };
      }
      await writeConfigFile(validated.config);
      const valueLabel =
        typeof configCommand.value === "string"
          ? `"${configCommand.value}"`
          : JSON.stringify(configCommand.value);
      return {
        shouldContinue: false,
        reply: {
          text: `⚙️ Config updated: ${configCommand.path}=${valueLabel ?? "null"}`,
        },
      };
    }
  }

  const debugCommand = allowTextCommands
    ? parseDebugCommand(command.commandBodyNormalized)
    : null;
  if (debugCommand) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /debug from unauthorized sender: ${command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (cfg.commands?.debug !== true) {
      return {
        shouldContinue: false,
        reply: {
          text: "⚠️ /debug is disabled. Set commands.debug=true to enable.",
        },
      };
    }
    if (debugCommand.action === "error") {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${debugCommand.message}` },
      };
    }
    if (debugCommand.action === "show") {
      const overrides = getConfigOverrides();
      const hasOverrides = Object.keys(overrides).length > 0;
      if (!hasOverrides) {
        return {
          shouldContinue: false,
          reply: { text: "⚙️ Debug overrides: (none)" },
        };
      }
      const json = JSON.stringify(overrides, null, 2);
      return {
        shouldContinue: false,
        reply: {
          text: `⚙️ Debug overrides (memory-only):\n\`\`\`json\n${json}\n\`\`\``,
        },
      };
    }
    if (debugCommand.action === "reset") {
      resetConfigOverrides();
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Debug overrides cleared; using config on disk." },
      };
    }
    if (debugCommand.action === "unset") {
      const result = unsetConfigOverride(debugCommand.path);
      if (!result.ok) {
        return {
          shouldContinue: false,
          reply: { text: `⚠️ ${result.error ?? "Invalid path."}` },
        };
      }
      if (!result.removed) {
        return {
          shouldContinue: false,
          reply: {
            text: `⚙️ No debug override found for ${debugCommand.path}.`,
          },
        };
      }
      return {
        shouldContinue: false,
        reply: { text: `⚙️ Debug override removed for ${debugCommand.path}.` },
      };
    }
    if (debugCommand.action === "set") {
      const result = setConfigOverride(debugCommand.path, debugCommand.value);
      if (!result.ok) {
        return {
          shouldContinue: false,
          reply: { text: `⚠️ ${result.error ?? "Invalid override."}` },
        };
      }
      const valueLabel =
        typeof debugCommand.value === "string"
          ? `"${debugCommand.value}"`
          : JSON.stringify(debugCommand.value);
      return {
        shouldContinue: false,
        reply: {
          text: `⚙️ Debug override set: ${debugCommand.path}=${valueLabel ?? "null"}`,
        },
      };
    }
  }

  const stopRequested = command.commandBodyNormalized === "/stop";
  if (allowTextCommands && stopRequested) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /stop from unauthorized sender: ${command.senderId || "<unknown>"}`,
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
        `Ignoring /compact from unauthorized sender: ${command.senderId || "<unknown>"}`,
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
      rawBody: ctx.CommandBody ?? ctx.RawBody ?? ctx.Body,
      ctx,
      cfg,
      agentId: params.agentId,
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
    enqueueSystemEvent(line, { sessionKey });
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
