import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../agents/agent-scope.js";
import { resolveModelRefFromString } from "../agents/model-selection.js";
import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunStreaming,
  resolveEmbeddedSessionLane,
} from "../agents/pi-embedded.js";
import {
  ensureSandboxWorkspaceForSession,
  resolveSandboxRuntimeStatus,
} from "../agents/sandbox.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  ensureAgentWorkspace,
} from "../agents/workspace.js";
import { getChannelDock } from "../channels/dock.js";
import {
  CHAT_CHANNEL_ORDER,
  normalizeChannelId,
} from "../channels/registry.js";
import {
  type AgentElevatedAllowFromConfig,
  type ClawdbotConfig,
  loadConfig,
} from "../config/config.js";
import {
  resolveSessionFilePath,
  saveSessionStore,
} from "../config/sessions.js";
import { logVerbose } from "../globals.js";
import { clearCommandLane, getQueueSize } from "../process/command-queue.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { isReasoningTagProvider } from "../utils/provider-utils.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import { hasControlCommand } from "./command-detection.js";
import {
  listChatCommands,
  shouldHandleTextCommands,
} from "./commands-registry.js";
import { buildInboundMediaNote } from "./media-note.js";
import { getAbortMemory } from "./reply/abort.js";
import { runReplyAgent } from "./reply/agent-runner.js";
import { resolveBlockStreamingChunking } from "./reply/block-streaming.js";
import { applySessionHints } from "./reply/body.js";
import {
  buildCommandContext,
  buildStatusReply,
  handleCommands,
} from "./reply/commands.js";
import {
  applyInlineDirectivesFastLane,
  handleDirectiveOnly,
  type InlineDirectives,
  isDirectiveOnly,
  parseInlineDirectives,
  persistInlineDirectives,
  resolveDefaultModel,
} from "./reply/directive-handling.js";
import {
  buildGroupIntro,
  defaultGroupActivation,
  resolveGroupRequireMention,
} from "./reply/groups.js";
import {
  CURRENT_MESSAGE_MARKER,
  stripMentions,
  stripStructuralPrefixes,
} from "./reply/mentions.js";
import {
  createModelSelectionState,
  resolveContextTokens,
} from "./reply/model-selection.js";
import { resolveQueueSettings } from "./reply/queue.js";
import { initSessionState } from "./reply/session.js";
import {
  ensureSkillSnapshot,
  prependSystemEvents,
} from "./reply/session-updates.js";
import { createTypingController } from "./reply/typing.js";
import {
  createTypingSignaler,
  resolveTypingMode,
} from "./reply/typing-mode.js";
import type { MsgContext, TemplateContext } from "./templating.js";
import {
  type ElevatedLevel,
  formatXHighModelHint,
  normalizeThinkLevel,
  type ReasoningLevel,
  supportsXHighThinking,
  type ThinkLevel,
  type VerboseLevel,
} from "./thinking.js";
import { SILENT_REPLY_TOKEN } from "./tokens.js";
import {
  hasAudioTranscriptionConfig,
  isAudio,
  transcribeInboundAudio,
} from "./transcription.js";
import type { GetReplyOptions, ReplyPayload } from "./types.js";

export {
  extractElevatedDirective,
  extractReasoningDirective,
  extractThinkDirective,
  extractVerboseDirective,
} from "./reply/directives.js";
export { extractQueueDirective } from "./reply/queue.js";
export { extractReplyToTag } from "./reply/reply-tags.js";
export type { GetReplyOptions, ReplyPayload } from "./types.js";

const BARE_SESSION_RESET_PROMPT =
  "A new session was started via /new or /reset. Say hi briefly (1-2 sentences) and ask what the user wants to do next. Do not mention internal steps, files, tools, or reasoning.";

function normalizeAllowToken(value?: string) {
  if (!value) return "";
  return value.trim().toLowerCase();
}

function slugAllowToken(value?: string) {
  if (!value) return "";
  let text = value.trim().toLowerCase();
  if (!text) return "";
  text = text.replace(/^[@#]+/, "");
  text = text.replace(/[\s_]+/g, "-");
  text = text.replace(/[^a-z0-9-]+/g, "-");
  return text.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

const SENDER_PREFIXES = [
  ...CHAT_CHANNEL_ORDER,
  INTERNAL_MESSAGE_CHANNEL,
  "user",
  "group",
  "channel",
];
const SENDER_PREFIX_RE = new RegExp(`^(${SENDER_PREFIXES.join("|")}):`, "i");

function stripSenderPrefix(value?: string) {
  if (!value) return "";
  const trimmed = value.trim();
  return trimmed.replace(SENDER_PREFIX_RE, "");
}

const INLINE_SIMPLE_COMMAND_ALIASES = new Map<string, string>([
  ["/help", "/help"],
  ["/commands", "/commands"],
  ["/whoami", "/whoami"],
  ["/id", "/whoami"],
]);
const INLINE_SIMPLE_COMMAND_RE =
  /(?:^|\s)\/(help|commands|whoami|id)(?=$|\s|:)/i;

const INLINE_STATUS_RE = /(?:^|\s)\/(?:status|usage)(?=$|\s|:)(?:\s*:\s*)?/gi;

function extractInlineSimpleCommand(body?: string): {
  command: string;
  cleaned: string;
} | null {
  if (!body) return null;
  const match = body.match(INLINE_SIMPLE_COMMAND_RE);
  if (!match || match.index === undefined) return null;
  const alias = `/${match[1].toLowerCase()}`;
  const command = INLINE_SIMPLE_COMMAND_ALIASES.get(alias);
  if (!command) return null;
  const cleaned = body.replace(match[0], " ").replace(/\s+/g, " ").trim();
  return { command, cleaned };
}

function stripInlineStatus(body: string): {
  cleaned: string;
  didStrip: boolean;
} {
  const trimmed = body.trim();
  if (!trimmed) return { cleaned: "", didStrip: false };
  const cleaned = trimmed
    .replace(INLINE_STATUS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { cleaned, didStrip: cleaned !== trimmed };
}

function resolveElevatedAllowList(
  allowFrom: AgentElevatedAllowFromConfig | undefined,
  provider: string,
  fallbackAllowFrom?: Array<string | number>,
): Array<string | number> | undefined {
  if (!allowFrom) return fallbackAllowFrom;
  const value = allowFrom[provider];
  return Array.isArray(value) ? value : fallbackAllowFrom;
}

function isApprovedElevatedSender(params: {
  provider: string;
  ctx: MsgContext;
  allowFrom?: AgentElevatedAllowFromConfig;
  fallbackAllowFrom?: Array<string | number>;
}): boolean {
  const rawAllow = resolveElevatedAllowList(
    params.allowFrom,
    params.provider,
    params.fallbackAllowFrom,
  );
  if (!rawAllow || rawAllow.length === 0) return false;

  const allowTokens = rawAllow
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  if (allowTokens.length === 0) return false;
  if (allowTokens.some((entry) => entry === "*")) return true;

  const tokens = new Set<string>();
  const addToken = (value?: string) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    tokens.add(trimmed);
    const normalized = normalizeAllowToken(trimmed);
    if (normalized) tokens.add(normalized);
    const slugged = slugAllowToken(trimmed);
    if (slugged) tokens.add(slugged);
  };

  addToken(params.ctx.SenderName);
  addToken(params.ctx.SenderUsername);
  addToken(params.ctx.SenderTag);
  addToken(params.ctx.SenderE164);
  addToken(params.ctx.From);
  addToken(stripSenderPrefix(params.ctx.From));
  addToken(params.ctx.To);
  addToken(stripSenderPrefix(params.ctx.To));

  for (const rawEntry of allowTokens) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const stripped = stripSenderPrefix(entry);
    if (tokens.has(entry) || tokens.has(stripped)) return true;
    const normalized = normalizeAllowToken(stripped);
    if (normalized && tokens.has(normalized)) return true;
    const slugged = slugAllowToken(stripped);
    if (slugged && tokens.has(slugged)) return true;
  }

  return false;
}

function resolveElevatedPermissions(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  ctx: MsgContext;
  provider: string;
}): {
  enabled: boolean;
  allowed: boolean;
  failures: Array<{ gate: string; key: string }>;
} {
  const globalConfig = params.cfg.tools?.elevated;
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId)?.tools
    ?.elevated;
  const globalEnabled = globalConfig?.enabled !== false;
  const agentEnabled = agentConfig?.enabled !== false;
  const enabled = globalEnabled && agentEnabled;
  const failures: Array<{ gate: string; key: string }> = [];
  if (!globalEnabled)
    failures.push({ gate: "enabled", key: "tools.elevated.enabled" });
  if (!agentEnabled)
    failures.push({
      gate: "enabled",
      key: "agents.list[].tools.elevated.enabled",
    });
  if (!enabled) return { enabled, allowed: false, failures };
  if (!params.provider) {
    failures.push({ gate: "provider", key: "ctx.Provider" });
    return { enabled, allowed: false, failures };
  }

  const normalizedProvider = normalizeChannelId(params.provider);
  const dockFallbackAllowFrom = normalizedProvider
    ? getChannelDock(normalizedProvider)?.elevated?.allowFromFallback?.({
        cfg: params.cfg,
        accountId: params.ctx.AccountId,
      })
    : undefined;
  const fallbackAllowFrom = dockFallbackAllowFrom;
  const globalAllowed = isApprovedElevatedSender({
    provider: params.provider,
    ctx: params.ctx,
    allowFrom: globalConfig?.allowFrom,
    fallbackAllowFrom,
  });
  if (!globalAllowed) {
    failures.push({
      gate: "allowFrom",
      key: `tools.elevated.allowFrom.${params.provider}`,
    });
    return { enabled, allowed: false, failures };
  }

  const agentAllowed = agentConfig?.allowFrom
    ? isApprovedElevatedSender({
        provider: params.provider,
        ctx: params.ctx,
        allowFrom: agentConfig.allowFrom,
        fallbackAllowFrom,
      })
    : true;
  if (!agentAllowed) {
    failures.push({
      gate: "allowFrom",
      key: `agents.list[].tools.elevated.allowFrom.${params.provider}`,
    });
  }
  return { enabled, allowed: globalAllowed && agentAllowed, failures };
}

function formatElevatedUnavailableMessage(params: {
  runtimeSandboxed: boolean;
  failures: Array<{ gate: string; key: string }>;
  sessionKey?: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `elevated is not available right now (runtime=${params.runtimeSandboxed ? "sandboxed" : "direct"}).`,
  );
  if (params.failures.length > 0) {
    lines.push(
      `Failing gates: ${params.failures
        .map((f) => `${f.gate} (${f.key})`)
        .join(", ")}`,
    );
  } else {
    lines.push(
      "Failing gates: enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled), allowFrom (tools.elevated.allowFrom.<provider>).",
    );
  }
  lines.push("Fix-it keys:");
  lines.push("- tools.elevated.enabled");
  lines.push("- tools.elevated.allowFrom.<provider>");
  lines.push("- agents.list[].tools.elevated.enabled");
  lines.push("- agents.list[].tools.elevated.allowFrom.<provider>");
  if (params.sessionKey) {
    lines.push(`See: clawdbot sandbox explain --session ${params.sessionKey}`);
  }
  return lines.join("\n");
}

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: ClawdbotConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const cfg = configOverride ?? loadConfig();
  const agentId = resolveSessionAgentId({
    sessionKey: ctx.SessionKey,
    config: cfg,
  });
  const agentCfg = cfg.agents?.defaults;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg,
    agentId,
  });
  let provider = defaultProvider;
  let model = defaultModel;
  if (opts?.isHeartbeat) {
    const heartbeatRaw = agentCfg?.heartbeat?.model?.trim() ?? "";
    const heartbeatRef = heartbeatRaw
      ? resolveModelRefFromString({
          raw: heartbeatRaw,
          defaultProvider,
          aliasIndex,
        })
      : null;
    if (heartbeatRef) {
      provider = heartbeatRef.ref.provider;
      model = heartbeatRef.ref.model;
    }
  }

  const workspaceDirRaw =
    resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
  });
  const workspaceDir = workspace.dir;
  const agentDir = resolveAgentDir(cfg, agentId);
  const timeoutMs = resolveAgentTimeoutMs({ cfg });
  const configuredTypingSeconds =
    agentCfg?.typingIntervalSeconds ?? sessionCfg?.typingIntervalSeconds;
  const typingIntervalSeconds =
    typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
  const typing = createTypingController({
    onReplyStart: opts?.onReplyStart,
    typingIntervalSeconds,
    silentToken: SILENT_REPLY_TOKEN,
    log: defaultRuntime.log,
  });
  opts?.onTypingController?.(typing);

  let transcribedText: string | undefined;
  if (hasAudioTranscriptionConfig(cfg) && isAudio(ctx.MediaType)) {
    const transcribed = await transcribeInboundAudio(cfg, ctx, defaultRuntime);
    if (transcribed?.text) {
      transcribedText = transcribed.text;
      ctx.Body = transcribed.text;
      ctx.Transcript = transcribed.text;
      logVerbose("Replaced Body with audio transcript for reply flow");
    }
  }

  const commandAuthorized = ctx.CommandAuthorized ?? true;
  resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  });
  const sessionState = await initSessionState({
    ctx,
    cfg,
    commandAuthorized,
  });
  let {
    sessionCtx,
    sessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
  } = sessionState;

  // Prefer CommandBody/RawBody (clean message without structural context) for directive parsing.
  // Keep `Body`/`BodyStripped` as the best-available prompt text (may include context).
  const commandSource =
    sessionCtx.CommandBody ??
    sessionCtx.RawBody ??
    sessionCtx.BodyStripped ??
    sessionCtx.Body ??
    "";
  const command = buildCommandContext({
    ctx,
    cfg,
    agentId,
    sessionKey,
    isGroup,
    triggerBodyNormalized,
    commandAuthorized,
  });
  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: command.surface,
    commandSource: ctx.CommandSource,
  });
  const clearInlineDirectives = (cleaned: string): InlineDirectives => ({
    cleaned,
    hasThinkDirective: false,
    thinkLevel: undefined,
    rawThinkLevel: undefined,
    hasVerboseDirective: false,
    verboseLevel: undefined,
    rawVerboseLevel: undefined,
    hasReasoningDirective: false,
    reasoningLevel: undefined,
    rawReasoningLevel: undefined,
    hasElevatedDirective: false,
    elevatedLevel: undefined,
    rawElevatedLevel: undefined,
    hasStatusDirective: false,
    hasModelDirective: false,
    rawModelDirective: undefined,
    hasQueueDirective: false,
    queueMode: undefined,
    queueReset: false,
    rawQueueMode: undefined,
    debounceMs: undefined,
    cap: undefined,
    dropPolicy: undefined,
    rawDebounce: undefined,
    rawCap: undefined,
    rawDrop: undefined,
    hasQueueOptions: false,
  });
  const reservedCommands = new Set(
    listChatCommands().flatMap((cmd) =>
      cmd.textAliases.map((a) => a.replace(/^\//, "").toLowerCase()),
    ),
  );
  const configuredAliases = Object.values(cfg.agents?.defaults?.models ?? {})
    .map((entry) => entry.alias?.trim())
    .filter((alias): alias is string => Boolean(alias))
    .filter((alias) => !reservedCommands.has(alias.toLowerCase()));
  const allowStatusDirective = allowTextCommands && command.isAuthorizedSender;
  let parsedDirectives = parseInlineDirectives(commandSource, {
    modelAliases: configuredAliases,
    allowStatusDirective,
  });
  const hasInlineStatus =
    parsedDirectives.hasStatusDirective &&
    parsedDirectives.cleaned.trim().length > 0;
  if (hasInlineStatus) {
    parsedDirectives = {
      ...parsedDirectives,
      hasStatusDirective: false,
    };
  }
  if (
    isGroup &&
    ctx.WasMentioned !== true &&
    parsedDirectives.hasElevatedDirective
  ) {
    if (parsedDirectives.elevatedLevel !== "off") {
      parsedDirectives = {
        ...parsedDirectives,
        hasElevatedDirective: false,
        elevatedLevel: undefined,
        rawElevatedLevel: undefined,
      };
    }
  }
  const hasInlineDirective =
    parsedDirectives.hasThinkDirective ||
    parsedDirectives.hasVerboseDirective ||
    parsedDirectives.hasReasoningDirective ||
    parsedDirectives.hasElevatedDirective ||
    parsedDirectives.hasModelDirective ||
    parsedDirectives.hasQueueDirective;
  if (hasInlineDirective) {
    const stripped = stripStructuralPrefixes(parsedDirectives.cleaned);
    const noMentions = isGroup
      ? stripMentions(stripped, ctx, cfg, agentId)
      : stripped;
    if (noMentions.trim().length > 0) {
      const directiveOnlyCheck = parseInlineDirectives(noMentions, {
        modelAliases: configuredAliases,
      });
      if (directiveOnlyCheck.cleaned.trim().length > 0) {
        const allowInlineStatus =
          parsedDirectives.hasStatusDirective &&
          allowTextCommands &&
          command.isAuthorizedSender;
        parsedDirectives = allowInlineStatus
          ? {
              ...clearInlineDirectives(parsedDirectives.cleaned),
              hasStatusDirective: true,
            }
          : clearInlineDirectives(parsedDirectives.cleaned);
      }
    }
  }
  let directives = commandAuthorized
    ? parsedDirectives
    : {
        ...parsedDirectives,
        hasThinkDirective: false,
        hasVerboseDirective: false,
        hasReasoningDirective: false,
        hasStatusDirective: false,
        hasModelDirective: false,
        hasQueueDirective: false,
        queueReset: false,
      };
  const existingBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  let cleanedBody = (() => {
    if (!existingBody) return parsedDirectives.cleaned;
    if (!sessionCtx.CommandBody && !sessionCtx.RawBody) {
      return parseInlineDirectives(existingBody, {
        modelAliases: configuredAliases,
        allowStatusDirective,
      }).cleaned;
    }

    const markerIndex = existingBody.indexOf(CURRENT_MESSAGE_MARKER);
    if (markerIndex < 0) {
      return parseInlineDirectives(existingBody, {
        modelAliases: configuredAliases,
        allowStatusDirective,
      }).cleaned;
    }

    const head = existingBody.slice(
      0,
      markerIndex + CURRENT_MESSAGE_MARKER.length,
    );
    const tail = existingBody.slice(
      markerIndex + CURRENT_MESSAGE_MARKER.length,
    );
    const cleanedTail = parseInlineDirectives(tail, {
      modelAliases: configuredAliases,
      allowStatusDirective,
    }).cleaned;
    return `${head}${cleanedTail}`;
  })();

  if (allowStatusDirective) {
    cleanedBody = stripInlineStatus(cleanedBody).cleaned;
  }

  sessionCtx.Body = cleanedBody;
  sessionCtx.BodyStripped = cleanedBody;

  const messageProviderKey =
    sessionCtx.Provider?.trim().toLowerCase() ??
    ctx.Provider?.trim().toLowerCase() ??
    "";
  const elevated = resolveElevatedPermissions({
    cfg,
    agentId,
    ctx,
    provider: messageProviderKey,
  });
  const elevatedEnabled = elevated.enabled;
  const elevatedAllowed = elevated.allowed;
  const elevatedFailures = elevated.failures;
  if (
    directives.hasElevatedDirective &&
    (!elevatedEnabled || !elevatedAllowed)
  ) {
    typing.cleanup();
    const runtimeSandboxed = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: ctx.SessionKey,
    }).sandboxed;
    return {
      text: formatElevatedUnavailableMessage({
        runtimeSandboxed,
        failures: elevatedFailures,
        sessionKey: ctx.SessionKey,
      }),
    };
  }

  const requireMention = resolveGroupRequireMention({
    cfg,
    ctx: sessionCtx,
    groupResolution,
  });
  const defaultActivation = defaultGroupActivation(requireMention);
  let resolvedThinkLevel =
    (directives.thinkLevel as ThinkLevel | undefined) ??
    (sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
    (agentCfg?.thinkingDefault as ThinkLevel | undefined);

  const resolvedVerboseLevel =
    (directives.verboseLevel as VerboseLevel | undefined) ??
    (sessionEntry?.verboseLevel as VerboseLevel | undefined) ??
    (agentCfg?.verboseDefault as VerboseLevel | undefined);
  const resolvedReasoningLevel: ReasoningLevel =
    (directives.reasoningLevel as ReasoningLevel | undefined) ??
    (sessionEntry?.reasoningLevel as ReasoningLevel | undefined) ??
    "off";
  const resolvedElevatedLevel = elevatedAllowed
    ? ((directives.elevatedLevel as ElevatedLevel | undefined) ??
      (sessionEntry?.elevatedLevel as ElevatedLevel | undefined) ??
      (agentCfg?.elevatedDefault as ElevatedLevel | undefined) ??
      "on")
    : "off";
  const resolvedBlockStreaming =
    opts?.disableBlockStreaming === true
      ? "off"
      : opts?.disableBlockStreaming === false
        ? "on"
        : agentCfg?.blockStreamingDefault === "on"
          ? "on"
          : "off";
  const resolvedBlockStreamingBreak: "text_end" | "message_end" =
    agentCfg?.blockStreamingBreak === "message_end"
      ? "message_end"
      : "text_end";
  const blockStreamingEnabled =
    resolvedBlockStreaming === "on" && opts?.disableBlockStreaming !== true;
  const blockReplyChunking = blockStreamingEnabled
    ? resolveBlockStreamingChunking(
        cfg,
        sessionCtx.Provider,
        sessionCtx.AccountId,
      )
    : undefined;

  const modelState = await createModelSelectionState({
    cfg,
    agentCfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultProvider,
    defaultModel,
    provider,
    model,
    hasModelDirective: directives.hasModelDirective,
  });
  provider = modelState.provider;
  model = modelState.model;

  let contextTokens = resolveContextTokens({
    agentCfg,
    model,
  });

  const initialModelLabel = `${provider}/${model}`;
  const formatModelSwitchEvent = (label: string, alias?: string) =>
    alias
      ? `Model switched to ${alias} (${label}).`
      : `Model switched to ${label}.`;
  const isModelListAlias =
    directives.hasModelDirective &&
    ["status", "list"].includes(
      directives.rawModelDirective?.trim().toLowerCase() ?? "",
    );
  const effectiveModelDirective = isModelListAlias
    ? undefined
    : directives.rawModelDirective;

  const inlineStatusRequested =
    hasInlineStatus && allowTextCommands && command.isAuthorizedSender;

  // Inline control directives should apply immediately, even when mixed with text.
  let directiveAck: ReplyPayload | undefined;

  if (!command.isAuthorizedSender) {
    directives = {
      ...directives,
      hasThinkDirective: false,
      hasVerboseDirective: false,
      hasReasoningDirective: false,
      hasElevatedDirective: false,
      hasStatusDirective: false,
      hasModelDirective: false,
      hasQueueDirective: false,
      queueReset: false,
    };
  }

  if (
    isDirectiveOnly({
      directives,
      cleanedBody: directives.cleaned,
      ctx,
      cfg,
      agentId,
      isGroup,
    })
  ) {
    if (!command.isAuthorizedSender) {
      typing.cleanup();
      return undefined;
    }
    const resolvedDefaultThinkLevel =
      (sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
      (agentCfg?.thinkingDefault as ThinkLevel | undefined) ??
      (await modelState.resolveDefaultThinkingLevel());
    const currentThinkLevel = resolvedDefaultThinkLevel;
    const currentVerboseLevel =
      (sessionEntry?.verboseLevel as VerboseLevel | undefined) ??
      (agentCfg?.verboseDefault as VerboseLevel | undefined);
    const currentReasoningLevel =
      (sessionEntry?.reasoningLevel as ReasoningLevel | undefined) ?? "off";
    const currentElevatedLevel =
      (sessionEntry?.elevatedLevel as ElevatedLevel | undefined) ??
      (agentCfg?.elevatedDefault as ElevatedLevel | undefined);
    const directiveReply = await handleDirectiveOnly({
      cfg,
      directives,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      elevatedEnabled,
      elevatedAllowed,
      elevatedFailures,
      messageProviderKey,
      defaultProvider,
      defaultModel,
      aliasIndex,
      allowedModelKeys: modelState.allowedModelKeys,
      allowedModelCatalog: modelState.allowedModelCatalog,
      resetModelOverride: modelState.resetModelOverride,
      provider,
      model,
      initialModelLabel,
      formatModelSwitchEvent,
      currentThinkLevel,
      currentVerboseLevel,
      currentReasoningLevel,
      currentElevatedLevel,
    });
    let statusReply: ReplyPayload | undefined;
    if (
      directives.hasStatusDirective &&
      allowTextCommands &&
      command.isAuthorizedSender
    ) {
      statusReply = await buildStatusReply({
        cfg,
        command,
        sessionEntry,
        sessionKey,
        sessionScope,
        provider,
        model,
        contextTokens,
        resolvedThinkLevel: resolvedDefaultThinkLevel,
        resolvedVerboseLevel: (currentVerboseLevel ?? "off") as VerboseLevel,
        resolvedReasoningLevel: (currentReasoningLevel ??
          "off") as ReasoningLevel,
        resolvedElevatedLevel,
        resolveDefaultThinkingLevel: async () => resolvedDefaultThinkLevel,
        isGroup,
        defaultGroupActivation: () => defaultActivation,
      });
    }
    typing.cleanup();
    if (statusReply?.text && directiveReply?.text) {
      return { text: `${directiveReply.text}\n${statusReply.text}` };
    }
    return statusReply ?? directiveReply;
  }

  const hasAnyDirective =
    directives.hasThinkDirective ||
    directives.hasVerboseDirective ||
    directives.hasReasoningDirective ||
    directives.hasElevatedDirective ||
    directives.hasModelDirective ||
    directives.hasQueueDirective ||
    directives.hasStatusDirective;

  if (hasAnyDirective && command.isAuthorizedSender) {
    const fastLane = await applyInlineDirectivesFastLane({
      directives,
      commandAuthorized: command.isAuthorizedSender,
      ctx,
      cfg,
      agentId,
      isGroup,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      elevatedEnabled,
      elevatedAllowed,
      elevatedFailures,
      messageProviderKey,
      defaultProvider,
      defaultModel,
      aliasIndex,
      allowedModelKeys: modelState.allowedModelKeys,
      allowedModelCatalog: modelState.allowedModelCatalog,
      resetModelOverride: modelState.resetModelOverride,
      provider,
      model,
      initialModelLabel,
      formatModelSwitchEvent,
      agentCfg,
      modelState: {
        resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
        allowedModelKeys: modelState.allowedModelKeys,
        allowedModelCatalog: modelState.allowedModelCatalog,
        resetModelOverride: modelState.resetModelOverride,
      },
    });
    directiveAck = fastLane.directiveAck;
    provider = fastLane.provider;
    model = fastLane.model;
  }

  const persisted = await persistInlineDirectives({
    directives,
    effectiveModelDirective,
    cfg,
    agentDir,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys: modelState.allowedModelKeys,
    provider,
    model,
    initialModelLabel,
    formatModelSwitchEvent,
    agentCfg,
  });
  provider = persisted.provider;
  model = persisted.model;
  contextTokens = persisted.contextTokens;

  const perMessageQueueMode =
    directives.hasQueueDirective && !directives.queueReset
      ? directives.queueMode
      : undefined;
  const perMessageQueueOptions =
    directives.hasQueueDirective && !directives.queueReset
      ? {
          debounceMs: directives.debounceMs,
          cap: directives.cap,
          dropPolicy: directives.dropPolicy,
        }
      : undefined;

  const sendInlineReply = async (reply?: ReplyPayload) => {
    if (!reply) return;
    if (!opts?.onBlockReply) return;
    await opts.onBlockReply(reply);
  };

  const inlineCommand =
    allowTextCommands && command.isAuthorizedSender
      ? extractInlineSimpleCommand(cleanedBody)
      : null;
  if (inlineCommand) {
    cleanedBody = inlineCommand.cleaned;
    sessionCtx.Body = cleanedBody;
    sessionCtx.BodyStripped = cleanedBody;
  }

  const handleInlineStatus =
    !isDirectiveOnly({
      directives,
      cleanedBody: directives.cleaned,
      ctx,
      cfg,
      agentId,
      isGroup,
    }) && inlineStatusRequested;
  if (handleInlineStatus) {
    const inlineStatusReply = await buildStatusReply({
      cfg,
      command,
      sessionEntry,
      sessionKey,
      sessionScope,
      provider,
      model,
      contextTokens,
      resolvedThinkLevel,
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
      isGroup,
      defaultGroupActivation: () => defaultActivation,
    });
    await sendInlineReply(inlineStatusReply);
    directives = { ...directives, hasStatusDirective: false };
  }

  if (inlineCommand) {
    const inlineCommandContext = {
      ...command,
      rawBodyNormalized: inlineCommand.command,
      commandBodyNormalized: inlineCommand.command,
    };
    const inlineResult = await handleCommands({
      ctx,
      cfg,
      command: inlineCommandContext,
      agentId,
      directives,
      elevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        failures: elevatedFailures,
      },
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      sessionScope,
      workspaceDir,
      defaultGroupActivation: () => defaultActivation,
      resolvedThinkLevel,
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
      provider,
      model,
      contextTokens,
      isGroup,
    });
    if (inlineResult.reply) {
      if (!inlineCommand.cleaned) {
        typing.cleanup();
        return inlineResult.reply;
      }
      await sendInlineReply(inlineResult.reply);
    }
  }

  if (directiveAck) {
    await sendInlineReply(directiveAck);
  }

  const isEmptyConfig = Object.keys(cfg).length === 0;
  const skipWhenConfigEmpty = command.channelId
    ? Boolean(getChannelDock(command.channelId)?.commands?.skipWhenConfigEmpty)
    : false;
  if (
    skipWhenConfigEmpty &&
    isEmptyConfig &&
    command.from &&
    command.to &&
    command.from !== command.to
  ) {
    typing.cleanup();
    return undefined;
  }

  if (!sessionEntry && command.abortKey) {
    abortedLastRun = getAbortMemory(command.abortKey) ?? false;
  }

  const commandResult = await handleCommands({
    ctx,
    cfg,
    command,
    agentId,
    directives,
    elevated: {
      enabled: elevatedEnabled,
      allowed: elevatedAllowed,
      failures: elevatedFailures,
    },
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    defaultGroupActivation: () => defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    isGroup,
  });
  if (!commandResult.shouldContinue) {
    typing.cleanup();
    return commandResult.reply;
  }

  await stageSandboxMedia({
    ctx,
    sessionCtx,
    cfg,
    sessionKey,
    workspaceDir,
  });

  const isFirstTurnInSession = isNewSession || !systemSent;
  const isGroupChat = sessionCtx.ChatType === "group";
  const wasMentioned = ctx.WasMentioned === true;
  const isHeartbeat = opts?.isHeartbeat === true;
  const typingMode = resolveTypingMode({
    configured: sessionCfg?.typingMode ?? agentCfg?.typingMode,
    isGroupChat,
    wasMentioned,
    isHeartbeat,
  });
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat,
  });
  const shouldInjectGroupIntro = Boolean(
    isGroupChat &&
      (isFirstTurnInSession || sessionEntry?.groupActivationNeedsSystemIntro),
  );
  const groupIntro = shouldInjectGroupIntro
    ? buildGroupIntro({
        cfg,
        sessionCtx,
        sessionEntry,
        defaultActivation,
        silentToken: SILENT_REPLY_TOKEN,
      })
    : "";
  const groupSystemPrompt = sessionCtx.GroupSystemPrompt?.trim() ?? "";
  const extraSystemPrompt = [groupIntro, groupSystemPrompt]
    .filter(Boolean)
    .join("\n\n");
  const baseBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  // Use CommandBody/RawBody for bare reset detection (clean message without structural context).
  const rawBodyTrimmed = (
    ctx.CommandBody ??
    ctx.RawBody ??
    ctx.Body ??
    ""
  ).trim();
  const baseBodyTrimmedRaw = baseBody.trim();
  if (
    allowTextCommands &&
    (!commandAuthorized || !command.isAuthorizedSender) &&
    !baseBodyTrimmedRaw &&
    hasControlCommand(commandSource, cfg)
  ) {
    typing.cleanup();
    return undefined;
  }
  const isBareSessionReset =
    isNewSession &&
    baseBodyTrimmedRaw.length === 0 &&
    rawBodyTrimmed.length > 0;
  const baseBodyFinal = isBareSessionReset
    ? BARE_SESSION_RESET_PROMPT
    : baseBody;
  const baseBodyTrimmed = baseBodyFinal.trim();
  if (!baseBodyTrimmed) {
    await typing.onReplyStart();
    logVerbose("Inbound body empty after normalization; skipping agent run");
    typing.cleanup();
    return {
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    };
  }
  let prefixedBodyBase = await applySessionHints({
    baseBody: baseBodyFinal,
    abortedLastRun,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    abortKey: command.abortKey,
    messageId: sessionCtx.MessageSid,
  });
  const isGroupSession =
    sessionEntry?.chatType === "group" || sessionEntry?.chatType === "room";
  const isMainSession =
    !isGroupSession && sessionKey === normalizeMainKey(sessionCfg?.mainKey);
  prefixedBodyBase = await prependSystemEvents({
    cfg,
    sessionKey,
    isMainSession,
    isNewSession,
    prefixedBodyBase,
  });
  const threadStarterBody = ctx.ThreadStarterBody?.trim();
  const threadStarterNote =
    isNewSession && threadStarterBody
      ? `[Thread starter - for context]\n${threadStarterBody}`
      : undefined;
  const skillResult = await ensureSkillSnapshot({
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionId,
    isFirstTurnInSession,
    workspaceDir,
    cfg,
    skillFilter: opts?.skillFilter,
  });
  sessionEntry = skillResult.sessionEntry ?? sessionEntry;
  systemSent = skillResult.systemSent;
  const skillsSnapshot = skillResult.skillsSnapshot;
  const prefixedBody = transcribedText
    ? [threadStarterNote, prefixedBodyBase, `Transcript:\n${transcribedText}`]
        .filter(Boolean)
        .join("\n\n")
    : [threadStarterNote, prefixedBodyBase].filter(Boolean).join("\n\n");
  const mediaNote = buildInboundMediaNote(ctx);
  const mediaReplyHint = mediaNote
    ? "To send an image back, add a line like: MEDIA:https://example.com/image.jpg (no spaces). Keep caption in the text body."
    : undefined;
  let prefixedCommandBody = mediaNote
    ? [mediaNote, mediaReplyHint, prefixedBody ?? ""]
        .filter(Boolean)
        .join("\n")
        .trim()
    : prefixedBody;
  if (!resolvedThinkLevel && prefixedCommandBody) {
    const parts = prefixedCommandBody.split(/\s+/);
    const maybeLevel = normalizeThinkLevel(parts[0]);
    if (
      maybeLevel &&
      (maybeLevel !== "xhigh" || supportsXHighThinking(provider, model))
    ) {
      resolvedThinkLevel = maybeLevel;
      prefixedCommandBody = parts.slice(1).join(" ").trim();
    }
  }
  if (!resolvedThinkLevel) {
    resolvedThinkLevel = await modelState.resolveDefaultThinkingLevel();
  }
  if (
    resolvedThinkLevel === "xhigh" &&
    !supportsXHighThinking(provider, model)
  ) {
    const explicitThink =
      directives.hasThinkDirective && directives.thinkLevel !== undefined;
    if (explicitThink) {
      typing.cleanup();
      return {
        text: `Thinking level "xhigh" is only supported for ${formatXHighModelHint()}. Use /think high or switch to one of those models.`,
      };
    }
    resolvedThinkLevel = "high";
    if (
      sessionEntry &&
      sessionStore &&
      sessionKey &&
      sessionEntry.thinkingLevel === "xhigh"
    ) {
      sessionEntry.thinkingLevel = "high";
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    }
  }
  const sessionIdFinal = sessionId ?? crypto.randomUUID();
  const sessionFile = resolveSessionFilePath(sessionIdFinal, sessionEntry);
  const queueBodyBase = transcribedText
    ? [threadStarterNote, baseBodyFinal, `Transcript:\n${transcribedText}`]
        .filter(Boolean)
        .join("\n\n")
    : [threadStarterNote, baseBodyFinal].filter(Boolean).join("\n\n");
  const queuedBody = mediaNote
    ? [mediaNote, mediaReplyHint, queueBodyBase]
        .filter(Boolean)
        .join("\n")
        .trim()
    : queueBodyBase;
  const resolvedQueue = resolveQueueSettings({
    cfg,
    channel: sessionCtx.Provider,
    sessionEntry,
    inlineMode: perMessageQueueMode,
    inlineOptions: perMessageQueueOptions,
  });
  const sessionLaneKey = resolveEmbeddedSessionLane(
    sessionKey ?? sessionIdFinal,
  );
  const laneSize = getQueueSize(sessionLaneKey);
  if (resolvedQueue.mode === "interrupt" && laneSize > 0) {
    const cleared = clearCommandLane(sessionLaneKey);
    const aborted = abortEmbeddedPiRun(sessionIdFinal);
    logVerbose(
      `Interrupting ${sessionLaneKey} (cleared ${cleared}, aborted=${aborted})`,
    );
  }
  const queueKey = sessionKey ?? sessionIdFinal;
  const isActive = isEmbeddedPiRunActive(sessionIdFinal);
  const isStreaming = isEmbeddedPiRunStreaming(sessionIdFinal);
  const shouldSteer =
    resolvedQueue.mode === "steer" || resolvedQueue.mode === "steer-backlog";
  const shouldFollowup =
    resolvedQueue.mode === "followup" ||
    resolvedQueue.mode === "collect" ||
    resolvedQueue.mode === "steer-backlog";
  const authProfileId = sessionEntry?.authProfileOverride;
  const followupRun = {
    prompt: queuedBody,
    messageId: sessionCtx.MessageSid,
    summaryLine: baseBodyTrimmedRaw,
    enqueuedAt: Date.now(),
    // Originating channel for reply routing.
    originatingChannel: ctx.OriginatingChannel,
    originatingTo: ctx.OriginatingTo,
    originatingAccountId: ctx.AccountId,
    originatingThreadId: ctx.MessageThreadId,
    run: {
      agentId,
      agentDir,
      sessionId: sessionIdFinal,
      sessionKey,
      messageProvider: sessionCtx.Provider?.trim().toLowerCase() || undefined,
      agentAccountId: sessionCtx.AccountId,
      sessionFile,
      workspaceDir,
      config: cfg,
      skillsSnapshot,
      provider,
      model,
      authProfileId,
      thinkLevel: resolvedThinkLevel,
      verboseLevel: resolvedVerboseLevel,
      reasoningLevel: resolvedReasoningLevel,
      elevatedLevel: resolvedElevatedLevel,
      bashElevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        defaultLevel: resolvedElevatedLevel ?? "off",
      },
      timeoutMs,
      blockReplyBreak: resolvedBlockStreamingBreak,
      ownerNumbers:
        command.ownerList.length > 0 ? command.ownerList : undefined,
      extraSystemPrompt: extraSystemPrompt || undefined,
      ...(isReasoningTagProvider(provider) ? { enforceFinalTag: true } : {}),
    },
  };

  if (typingSignals.shouldStartImmediately) {
    await typingSignals.signalRunStart();
  }

  return runReplyAgent({
    commandBody: prefixedCommandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isStreaming,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens: agentCfg?.contextTokens,
    resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
  });
}

async function stageSandboxMedia(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: ClawdbotConfig;
  sessionKey?: string;
  workspaceDir: string;
}) {
  const { ctx, sessionCtx, cfg, sessionKey, workspaceDir } = params;
  const hasPathsArray =
    Array.isArray(ctx.MediaPaths) && ctx.MediaPaths.length > 0;
  const pathsFromArray = Array.isArray(ctx.MediaPaths)
    ? ctx.MediaPaths
    : undefined;
  const rawPaths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : ctx.MediaPath?.trim()
        ? [ctx.MediaPath.trim()]
        : [];
  if (rawPaths.length === 0 || !sessionKey) return;

  const sandbox = await ensureSandboxWorkspaceForSession({
    config: cfg,
    sessionKey,
    workspaceDir,
  });
  if (!sandbox) return;

  const resolveAbsolutePath = (value: string): string | null => {
    let resolved = value.trim();
    if (!resolved) return null;
    if (resolved.startsWith("file://")) {
      try {
        resolved = fileURLToPath(resolved);
      } catch {
        return null;
      }
    }
    if (!path.isAbsolute(resolved)) return null;
    return resolved;
  };

  try {
    const destDir = path.join(sandbox.workspaceDir, "media", "inbound");
    await fs.mkdir(destDir, { recursive: true });

    const usedNames = new Set<string>();
    const staged = new Map<string, string>(); // absolute source -> relative sandbox path

    for (const raw of rawPaths) {
      const source = resolveAbsolutePath(raw);
      if (!source) continue;
      if (staged.has(source)) continue;

      const baseName = path.basename(source);
      if (!baseName) continue;
      const parsed = path.parse(baseName);
      let fileName = baseName;
      let suffix = 1;
      while (usedNames.has(fileName)) {
        fileName = `${parsed.name}-${suffix}${parsed.ext}`;
        suffix += 1;
      }
      usedNames.add(fileName);

      const dest = path.join(destDir, fileName);
      await fs.copyFile(source, dest);
      const relative = path.posix.join("media", "inbound", fileName);
      staged.set(source, relative);
    }

    const rewriteIfStaged = (value: string | undefined): string | undefined => {
      const raw = value?.trim();
      if (!raw) return value;
      const abs = resolveAbsolutePath(raw);
      if (!abs) return value;
      const mapped = staged.get(abs);
      return mapped ?? value;
    };

    const nextMediaPaths = hasPathsArray
      ? rawPaths.map((p) => rewriteIfStaged(p) ?? p)
      : undefined;
    if (nextMediaPaths) {
      ctx.MediaPaths = nextMediaPaths;
      sessionCtx.MediaPaths = nextMediaPaths;
      ctx.MediaPath = nextMediaPaths[0];
      sessionCtx.MediaPath = nextMediaPaths[0];
    } else {
      const rewritten = rewriteIfStaged(ctx.MediaPath);
      if (rewritten && rewritten !== ctx.MediaPath) {
        ctx.MediaPath = rewritten;
        sessionCtx.MediaPath = rewritten;
      }
    }

    if (Array.isArray(ctx.MediaUrls) && ctx.MediaUrls.length > 0) {
      const nextUrls = ctx.MediaUrls.map((u) => rewriteIfStaged(u) ?? u);
      ctx.MediaUrls = nextUrls;
      sessionCtx.MediaUrls = nextUrls;
    }
    const rewrittenUrl = rewriteIfStaged(ctx.MediaUrl);
    if (rewrittenUrl && rewrittenUrl !== ctx.MediaUrl) {
      ctx.MediaUrl = rewrittenUrl;
      sessionCtx.MediaUrl = rewrittenUrl;
    }
  } catch (err) {
    logVerbose(`Failed to stage inbound media for sandbox: ${String(err)}`);
  }
}
