import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveModelRefFromString } from "../agents/model-selection.js";
import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunStreaming,
  resolveEmbeddedSessionLane,
} from "../agents/pi-embedded.js";
import { ensureSandboxWorkspaceForSession } from "../agents/sandbox.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  ensureAgentWorkspace,
} from "../agents/workspace.js";
import {
  type AgentElevatedAllowFromConfig,
  type ClawdbotConfig,
  loadConfig,
} from "../config/config.js";
import { resolveSessionTranscriptPath } from "../config/sessions.js";
import { logVerbose } from "../globals.js";
import { clearCommandLane, getQueueSize } from "../process/command-queue.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import { hasControlCommand } from "./command-detection.js";
import { getAbortMemory } from "./reply/abort.js";
import { runReplyAgent } from "./reply/agent-runner.js";
import { resolveBlockStreamingChunking } from "./reply/block-streaming.js";
import { applySessionHints } from "./reply/body.js";
import { buildCommandContext, handleCommands } from "./reply/commands.js";
import {
  handleDirectiveOnly,
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
import { stripMentions } from "./reply/mentions.js";
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
import type { MsgContext, TemplateContext } from "./templating.js";
import {
  type ElevatedLevel,
  normalizeThinkLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "./thinking.js";
import { SILENT_REPLY_TOKEN } from "./tokens.js";
import { isAudio, transcribeInboundAudio } from "./transcription.js";
import type { GetReplyOptions, ReplyPayload } from "./types.js";

export {
  extractElevatedDirective,
  extractThinkDirective,
  extractVerboseDirective,
} from "./reply/directives.js";
export { extractQueueDirective } from "./reply/queue.js";
export { extractReplyToTag } from "./reply/reply-tags.js";
export type { GetReplyOptions, ReplyPayload } from "./types.js";

const BARE_SESSION_RESET_PROMPT =
  "A new session was started via /new or /reset. Say hi briefly (1-2 sentences) and ask what the user wants to do next. Do not mention internal steps, files, tools, or reasoning.";

const CONTROL_COMMAND_PREFIX_RE =
  /^\/(?:status|help|thinking|think|t|verbose|v|elevated|elev|model|queue|activation|send|restart|reset|new|compact)\b/i;

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

function stripSenderPrefix(value?: string) {
  if (!value) return "";
  const trimmed = value.trim();
  return trimmed.replace(
    /^(whatsapp|telegram|discord|signal|imessage|webchat|user|group|channel):/i,
    "",
  );
}

function resolveElevatedAllowList(
  allowFrom: AgentElevatedAllowFromConfig | undefined,
  surface: string,
  discordFallback?: Array<string | number>,
): Array<string | number> | undefined {
  switch (surface) {
    case "whatsapp":
      return allowFrom?.whatsapp;
    case "telegram":
      return allowFrom?.telegram;
    case "discord": {
      const hasExplicit = Boolean(
        allowFrom && Object.hasOwn(allowFrom, "discord"),
      );
      if (hasExplicit) return allowFrom?.discord;
      return discordFallback;
    }
    case "signal":
      return allowFrom?.signal;
    case "imessage":
      return allowFrom?.imessage;
    case "webchat":
      return allowFrom?.webchat;
    default:
      return undefined;
  }
}

function isApprovedElevatedSender(params: {
  surface: string;
  ctx: MsgContext;
  allowFrom?: AgentElevatedAllowFromConfig;
  discordFallback?: Array<string | number>;
}): boolean {
  const rawAllow = resolveElevatedAllowList(
    params.allowFrom,
    params.surface,
    params.discordFallback,
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

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: ClawdbotConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const cfg = configOverride ?? loadConfig();
  const agentCfg = cfg.agent;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg,
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

  const workspaceDirRaw = cfg.agent?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: true,
  });
  const workspaceDir = workspace.dir;
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
  if (cfg.routing?.transcribeAudio && isAudio(ctx.MediaType)) {
    const transcribed = await transcribeInboundAudio(cfg, ctx, defaultRuntime);
    if (transcribed?.text) {
      transcribedText = transcribed.text;
      ctx.Body = transcribed.text;
      ctx.Transcript = transcribed.text;
      logVerbose("Replaced Body with audio transcript for reply flow");
    }
  }

  const commandAuthorized = ctx.CommandAuthorized ?? true;
  const commandAuth = resolveCommandAuthorization({
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

  const rawBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  const parsedDirectives = parseInlineDirectives(rawBody);
  const directives = commandAuthorized
    ? parsedDirectives
    : {
        ...parsedDirectives,
        hasThinkDirective: false,
        hasVerboseDirective: false,
        hasStatusDirective: false,
        hasModelDirective: false,
        hasQueueDirective: false,
        queueReset: false,
      };
  sessionCtx.Body = parsedDirectives.cleaned;
  sessionCtx.BodyStripped = parsedDirectives.cleaned;

  const surfaceKey =
    sessionCtx.Surface?.trim().toLowerCase() ??
    ctx.Surface?.trim().toLowerCase() ??
    "";
  const elevatedConfig = agentCfg?.elevated;
  const discordElevatedFallback =
    surfaceKey === "discord" ? cfg.discord?.dm?.allowFrom : undefined;
  const elevatedEnabled = elevatedConfig?.enabled !== false;
  const elevatedAllowed =
    elevatedEnabled &&
    Boolean(
      surfaceKey &&
        isApprovedElevatedSender({
          surface: surfaceKey,
          ctx,
          allowFrom: elevatedConfig?.allowFrom,
          discordFallback: discordElevatedFallback,
        }),
    );
  if (
    directives.hasElevatedDirective &&
    (!elevatedEnabled || !elevatedAllowed)
  ) {
    typing.cleanup();
    return { text: "elevated is not available right now." };
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
  const resolvedElevatedLevel = elevatedAllowed
    ? ((directives.elevatedLevel as ElevatedLevel | undefined) ??
      (sessionEntry?.elevatedLevel as ElevatedLevel | undefined) ??
      (agentCfg?.elevatedDefault as ElevatedLevel | undefined) ??
      "on")
    : "off";
  const resolvedBlockStreaming =
    agentCfg?.blockStreamingDefault === "off" ? "off" : "on";
  const resolvedBlockStreamingBreak: "text_end" | "message_end" =
    agentCfg?.blockStreamingBreak === "message_end"
      ? "message_end"
      : "text_end";
  const blockStreamingEnabled = resolvedBlockStreaming === "on";
  const blockReplyChunking = blockStreamingEnabled
    ? resolveBlockStreamingChunking(cfg, sessionCtx.Surface)
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

  if (
    isDirectiveOnly({
      directives,
      cleanedBody: directives.cleaned,
      ctx,
      cfg,
      isGroup,
    })
  ) {
    const directiveReply = await handleDirectiveOnly({
      cfg,
      directives,
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
      allowedModelCatalog: modelState.allowedModelCatalog,
      resetModelOverride: modelState.resetModelOverride,
      provider,
      model,
      initialModelLabel,
      formatModelSwitchEvent,
    });
    typing.cleanup();
    return directiveReply;
  }

  const persisted = await persistInlineDirectives({
    directives,
    effectiveModelDirective,
    cfg,
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

  const command = buildCommandContext({
    ctx,
    cfg,
    sessionKey,
    isGroup,
    triggerBodyNormalized,
    commandAuthorized,
  });
  const isEmptyConfig = Object.keys(cfg).length === 0;
  if (
    command.isWhatsAppSurface &&
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
    directives,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    defaultGroupActivation: () => defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
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
  const shouldEagerType = (!isGroupChat || wasMentioned) && !isHeartbeat;
  const shouldInjectGroupIntro = Boolean(
    isGroupChat &&
      (isFirstTurnInSession || sessionEntry?.groupActivationNeedsSystemIntro),
  );
  const groupIntro = shouldInjectGroupIntro
    ? buildGroupIntro({
        sessionCtx,
        sessionEntry,
        defaultActivation,
        silentToken: SILENT_REPLY_TOKEN,
      })
    : "";
  const baseBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  const rawBodyTrimmed = (ctx.Body ?? "").trim();
  const baseBodyTrimmedRaw = baseBody.trim();
  const strippedCommandBody = isGroup
    ? stripMentions(triggerBodyNormalized, ctx, cfg)
    : triggerBodyNormalized;
  if (
    !commandAuth.isAuthorizedSender &&
    CONTROL_COMMAND_PREFIX_RE.test(strippedCommandBody.trim())
  ) {
    typing.cleanup();
    return undefined;
  }
  if (!commandAuthorized && !baseBodyTrimmedRaw && hasControlCommand(rawBody)) {
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
    !isGroupSession && sessionKey === (sessionCfg?.mainKey ?? "main");
  prefixedBodyBase = await prependSystemEvents({
    cfg,
    sessionKey,
    isMainSession,
    isNewSession,
    prefixedBodyBase,
  });
  const skillResult = await ensureSkillSnapshot({
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionId,
    isFirstTurnInSession,
    workspaceDir,
    cfg,
  });
  sessionEntry = skillResult.sessionEntry ?? sessionEntry;
  systemSent = skillResult.systemSent;
  const skillsSnapshot = skillResult.skillsSnapshot;
  const prefixedBody = transcribedText
    ? [prefixedBodyBase, `Transcript:\n${transcribedText}`]
        .filter(Boolean)
        .join("\n\n")
    : prefixedBodyBase;
  const mediaNote = ctx.MediaPath?.length
    ? `[media attached: ${ctx.MediaPath}${ctx.MediaType ? ` (${ctx.MediaType})` : ""}${ctx.MediaUrl ? ` | ${ctx.MediaUrl}` : ""}]`
    : undefined;
  const mediaReplyHint = mediaNote
    ? "To send an image back, add a line like: MEDIA:https://example.com/image.jpg (no spaces). Keep caption in the text body."
    : undefined;
  let commandBody = mediaNote
    ? [mediaNote, mediaReplyHint, prefixedBody ?? ""]
        .filter(Boolean)
        .join("\n")
        .trim()
    : prefixedBody;
  if (!resolvedThinkLevel && commandBody) {
    const parts = commandBody.split(/\s+/);
    const maybeLevel = normalizeThinkLevel(parts[0]);
    if (maybeLevel) {
      resolvedThinkLevel = maybeLevel;
      commandBody = parts.slice(1).join(" ").trim();
    }
  }
  if (!resolvedThinkLevel) {
    resolvedThinkLevel = await modelState.resolveDefaultThinkingLevel();
  }
  const sessionIdFinal = sessionId ?? crypto.randomUUID();
  const sessionFile = resolveSessionTranscriptPath(sessionIdFinal);
  const queueBodyBase = transcribedText
    ? [baseBodyFinal, `Transcript:\n${transcribedText}`]
        .filter(Boolean)
        .join("\n\n")
    : baseBodyFinal;
  const queuedBody = mediaNote
    ? [mediaNote, mediaReplyHint, queueBodyBase]
        .filter(Boolean)
        .join("\n")
        .trim()
    : queueBodyBase;
  const resolvedQueue = resolveQueueSettings({
    cfg,
    surface: sessionCtx.Surface,
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
    summaryLine: baseBodyTrimmedRaw,
    enqueuedAt: Date.now(),
    run: {
      sessionId: sessionIdFinal,
      sessionKey,
      surface: sessionCtx.Surface?.trim().toLowerCase() || undefined,
      sessionFile,
      workspaceDir,
      config: cfg,
      skillsSnapshot,
      provider,
      model,
      authProfileId,
      thinkLevel: resolvedThinkLevel,
      verboseLevel: resolvedVerboseLevel,
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
      extraSystemPrompt: groupIntro || undefined,
      ...(provider === "ollama" ? { enforceFinalTag: true } : {}),
    },
  };

  if (shouldEagerType) {
    await typing.startTypingLoop();
  }

  return runReplyAgent({
    commandBody,
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
  const rawPath = ctx.MediaPath?.trim();
  if (!rawPath || !sessionKey) return;

  const sandbox = await ensureSandboxWorkspaceForSession({
    config: cfg,
    sessionKey,
    workspaceDir,
  });
  if (!sandbox) return;

  let source = rawPath;
  if (source.startsWith("file://")) {
    try {
      source = fileURLToPath(source);
    } catch {
      return;
    }
  }
  if (!path.isAbsolute(source)) return;

  const originalMediaPath = ctx.MediaPath;
  const originalMediaUrl = ctx.MediaUrl;

  try {
    const fileName = path.basename(source);
    if (!fileName) return;
    const destDir = path.join(sandbox.workspaceDir, "media", "inbound");
    await fs.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, fileName);
    await fs.copyFile(source, dest);

    const relative = path.posix.join("media", "inbound", fileName);
    ctx.MediaPath = relative;
    sessionCtx.MediaPath = relative;

    if (originalMediaUrl) {
      let normalizedUrl = originalMediaUrl;
      if (normalizedUrl.startsWith("file://")) {
        try {
          normalizedUrl = fileURLToPath(normalizedUrl);
        } catch {
          normalizedUrl = originalMediaUrl;
        }
      }
      if (normalizedUrl === originalMediaPath || normalizedUrl === source) {
        ctx.MediaUrl = relative;
        sessionCtx.MediaUrl = relative;
      }
    }
  } catch (err) {
    logVerbose(`Failed to stage inbound media for sandbox: ${String(err)}`);
  }
}
