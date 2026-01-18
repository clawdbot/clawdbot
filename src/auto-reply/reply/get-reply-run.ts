import crypto from "node:crypto";
import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunStreaming,
  resolveEmbeddedSessionLane,
} from "../../agents/pi-embedded.js";
import {
  ensureAuthProfileStore,
  isProfileInCooldown,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  resolveSessionFilePath,
  saveSessionStore,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { clearCommandLane, getQueueSize } from "../../process/command-queue.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { hasControlCommand } from "../command-detection.js";
import { buildInboundMediaNote } from "../media-note.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import {
  type ElevatedLevel,
  formatXHighModelHint,
  normalizeThinkLevel,
  type ReasoningLevel,
  supportsXHighThinking,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runReplyAgent } from "./agent-runner.js";
import { applySessionHints } from "./body.js";
import type { buildCommandContext } from "./commands.js";
import type { InlineDirectives } from "./directive-handling.js";
import { buildGroupIntro } from "./groups.js";
import type { createModelSelectionState } from "./model-selection.js";
import { resolveQueueSettings } from "./queue.js";
import { ensureSkillSnapshot, prependSystemEvents } from "./session-updates.js";
import type { TypingController } from "./typing.js";
import { createTypingSignaler, resolveTypingMode } from "./typing-mode.js";

type AgentDefaults = NonNullable<ClawdbotConfig["agents"]>["defaults"];
type ExecOverrides = Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;

const BARE_SESSION_RESET_PROMPT =
  "A new session was started via /new or /reset. Say hi briefly (1-2 sentences) and ask what the user wants to do next. Do not mention internal steps, files, tools, or reasoning.";

type RunPreparedReplyParams = {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: ClawdbotConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  sessionCfg: ClawdbotConfig["session"];
  commandAuthorized: boolean;
  command: ReturnType<typeof buildCommandContext>;
  commandSource: string;
  allowTextCommands: boolean;
  directives: InlineDirectives;
  defaultActivation: Parameters<typeof buildGroupIntro>[0]["defaultActivation"];
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  execOverrides?: ExecOverrides;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  provider: string;
  model: string;
  perMessageQueueMode?: InlineDirectives["queueMode"];
  perMessageQueueOptions?: {
    debounceMs?: number;
    cap?: number;
    dropPolicy?: InlineDirectives["dropPolicy"];
  };
  typing: TypingController;
  opts?: GetReplyOptions;
  defaultModel: string;
  timeoutMs: number;
  isNewSession: boolean;
  systemSent: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId?: string;
  storePath?: string;
  workspaceDir: string;
  abortedLastRun: boolean;
};

async function resolveSessionAuthProfileOverride(params: {
  cfg: ClawdbotConfig;
  provider: string;
  agentDir: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isNewSession: boolean;
}): Promise<string | undefined> {
  const {
    cfg,
    provider,
    agentDir,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    isNewSession,
  } = params;
  if (!sessionEntry || !sessionStore || !sessionKey) return sessionEntry?.authProfileOverride;

  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const order = resolveAuthProfileOrder({ cfg, store, provider });
  if (order.length === 0) return sessionEntry.authProfileOverride;

  const pickFirstAvailable = () =>
    order.find((profileId) => !isProfileInCooldown(store, profileId)) ?? order[0];
  const pickNextAvailable = (current: string) => {
    const startIndex = order.indexOf(current);
    if (startIndex < 0) return pickFirstAvailable();
    for (let offset = 1; offset <= order.length; offset += 1) {
      const candidate = order[(startIndex + offset) % order.length];
      if (!isProfileInCooldown(store, candidate)) return candidate;
    }
    return order[startIndex] ?? order[0];
  };

  const compactionCount = sessionEntry.compactionCount ?? 0;
  const storedCompaction =
    typeof sessionEntry.authProfileOverrideCompactionCount === "number"
      ? sessionEntry.authProfileOverrideCompactionCount
      : compactionCount;

  let current = sessionEntry.authProfileOverride?.trim();
  if (current && !order.includes(current)) current = undefined;

  const source =
    sessionEntry.authProfileOverrideSource ??
    (typeof sessionEntry.authProfileOverrideCompactionCount === "number"
      ? "auto"
      : current
        ? "user"
        : undefined);
  if (source === "user" && current && !isNewSession) {
    return current;
  }

  let next = current;
  if (isNewSession) {
    next = current ? pickNextAvailable(current) : pickFirstAvailable();
  } else if (current && compactionCount > storedCompaction) {
    next = pickNextAvailable(current);
  } else if (!current || isProfileInCooldown(store, current)) {
    next = pickFirstAvailable();
  }

  if (!next) return current;
  const shouldPersist =
    next !== sessionEntry.authProfileOverride ||
    sessionEntry.authProfileOverrideSource !== "auto" ||
    sessionEntry.authProfileOverrideCompactionCount !== compactionCount;
  if (shouldPersist) {
    sessionEntry.authProfileOverride = next;
    sessionEntry.authProfileOverrideSource = "auto";
    sessionEntry.authProfileOverrideCompactionCount = compactionCount;
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    if (storePath) {
      await saveSessionStore(storePath, sessionStore);
    }
  }

  return next;
}

export async function runPreparedReply(
  params: RunPreparedReplyParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    sessionCfg,
    commandAuthorized,
    command,
    commandSource,
    allowTextCommands,
    directives,
    defaultActivation,
    elevatedEnabled,
    elevatedAllowed,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    modelState,
    provider,
    model,
    perMessageQueueMode,
    perMessageQueueOptions,
    typing,
    opts,
    defaultModel,
    timeoutMs,
    isNewSession,
    systemSent,
    sessionKey,
    sessionId,
    storePath,
    workspaceDir,
    sessionStore,
  } = params;
  let {
    sessionEntry,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    abortedLastRun,
  } = params;
  let currentSystemSent = systemSent;

  const isFirstTurnInSession = isNewSession || !currentSystemSent;
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
    isGroupChat && (isFirstTurnInSession || sessionEntry?.groupActivationNeedsSystemIntro),
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
  const extraSystemPrompt = [groupIntro, groupSystemPrompt].filter(Boolean).join("\n\n");
  const baseBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  // Use CommandBody/RawBody for bare reset detection (clean message without structural context).
  const rawBodyTrimmed = (ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "").trim();
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
  const isBareNewOrReset = rawBodyTrimmed === "/new" || rawBodyTrimmed === "/reset";
  const isBareSessionReset =
    isNewSession &&
    ((baseBodyTrimmedRaw.length === 0 && rawBodyTrimmed.length > 0) || isBareNewOrReset);
  const baseBodyFinal = isBareSessionReset ? BARE_SESSION_RESET_PROMPT : baseBody;
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
  const isGroupSession = sessionEntry?.chatType === "group" || sessionEntry?.chatType === "channel";
  const isMainSession = !isGroupSession && sessionKey === normalizeMainKey(sessionCfg?.mainKey);
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
  currentSystemSent = skillResult.systemSent;
  const skillsSnapshot = skillResult.skillsSnapshot;
  const prefixedBody = [threadStarterNote, prefixedBodyBase].filter(Boolean).join("\n\n");
  const mediaNote = buildInboundMediaNote(ctx);
  const mediaReplyHint = mediaNote
    ? "To send an image back, add a line like: MEDIA:https://example.com/image.jpg (no spaces). Keep caption in the text body."
    : undefined;
  let prefixedCommandBody = mediaNote
    ? [mediaNote, mediaReplyHint, prefixedBody ?? ""].filter(Boolean).join("\n").trim()
    : prefixedBody;
  if (!resolvedThinkLevel && prefixedCommandBody) {
    const parts = prefixedCommandBody.split(/\s+/);
    const maybeLevel = normalizeThinkLevel(parts[0]);
    if (maybeLevel && (maybeLevel !== "xhigh" || supportsXHighThinking(provider, model))) {
      resolvedThinkLevel = maybeLevel;
      prefixedCommandBody = parts.slice(1).join(" ").trim();
    }
  }
  if (!resolvedThinkLevel) {
    resolvedThinkLevel = await modelState.resolveDefaultThinkingLevel();
  }
  if (resolvedThinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
    const explicitThink = directives.hasThinkDirective && directives.thinkLevel !== undefined;
    if (explicitThink) {
      typing.cleanup();
      return {
        text: `Thinking level "xhigh" is only supported for ${formatXHighModelHint()}. Use /think high or switch to one of those models.`,
      };
    }
    resolvedThinkLevel = "high";
    if (sessionEntry && sessionStore && sessionKey && sessionEntry.thinkingLevel === "xhigh") {
      sessionEntry.thinkingLevel = "high";
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = sessionEntry;
        });
      }
    }
  }
  const sessionIdFinal = sessionId ?? crypto.randomUUID();
  const sessionFile = resolveSessionFilePath(sessionIdFinal, sessionEntry);
  const queueBodyBase = [threadStarterNote, baseBodyFinal].filter(Boolean).join("\n\n");
  const queuedBody = mediaNote
    ? [mediaNote, mediaReplyHint, queueBodyBase].filter(Boolean).join("\n").trim()
    : queueBodyBase;
  const resolvedQueue = resolveQueueSettings({
    cfg,
    channel: sessionCtx.Provider,
    sessionEntry,
    inlineMode: perMessageQueueMode,
    inlineOptions: perMessageQueueOptions,
  });
  const sessionLaneKey = resolveEmbeddedSessionLane(sessionKey ?? sessionIdFinal);
  const laneSize = getQueueSize(sessionLaneKey);
  if (resolvedQueue.mode === "interrupt" && laneSize > 0) {
    const cleared = clearCommandLane(sessionLaneKey);
    const aborted = abortEmbeddedPiRun(sessionIdFinal);
    logVerbose(`Interrupting ${sessionLaneKey} (cleared ${cleared}, aborted=${aborted})`);
  }
  const queueKey = sessionKey ?? sessionIdFinal;
  const isActive = isEmbeddedPiRunActive(sessionIdFinal);
  const isStreaming = isEmbeddedPiRunStreaming(sessionIdFinal);
  const shouldSteer = resolvedQueue.mode === "steer" || resolvedQueue.mode === "steer-backlog";
  const shouldFollowup =
    resolvedQueue.mode === "followup" ||
    resolvedQueue.mode === "collect" ||
    resolvedQueue.mode === "steer-backlog";
  const authProfileId = await resolveSessionAuthProfileOverride({
    cfg,
    provider,
    agentDir,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    isNewSession,
  });
  const authProfileIdSource = sessionEntry?.authProfileOverrideSource;
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
      authProfileIdSource,
      thinkLevel: resolvedThinkLevel,
      verboseLevel: resolvedVerboseLevel,
      reasoningLevel: resolvedReasoningLevel,
      elevatedLevel: resolvedElevatedLevel,
      execOverrides,
      bashElevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        defaultLevel: resolvedElevatedLevel ?? "off",
      },
      timeoutMs,
      blockReplyBreak: resolvedBlockStreamingBreak,
      ownerNumbers: command.ownerList.length > 0 ? command.ownerList : undefined,
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
