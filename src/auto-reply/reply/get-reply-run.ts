import crypto from "node:crypto";
import { resolveSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveEmbeddedFullAccessState } from "../../agents/pi-embedded-runner/sandbox-info.js";
import type { EmbeddedFullAccessBlockedReason } from "../../agents/pi-embedded-runner/types.js";
import { resolveIngressWorkspaceOverrideForSpawnedRun } from "../../agents/spawned-context.js";
import type { SilentReplyPromptMode } from "../../agents/system-prompt.types.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import { resolveSessionStoreEntry } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveSilentReplySettings } from "../../config/silent-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { clearCommandLane, getQueueSize } from "../../process/command-queue.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { hasControlCommand } from "../command-detection.js";
import { resolveEnvelopeFormatOptions } from "../envelope.js";
import { HEARTBEAT_TRANSCRIPT_PROMPT } from "../heartbeat.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import {
  type ElevatedLevel,
  formatThinkingLevels,
  isThinkingLevelSupported,
  normalizeThinkLevel,
  type ReasoningLevel,
  resolveSupportedThinkingLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { applySessionHints } from "./body.js";
import type { buildCommandContext } from "./commands.js";
import type { InlineDirectives } from "./directive-handling.js";
import { isSystemEventProvider } from "./effective-reply-route.js";
import { shouldUseReplyFastTestRuntime } from "./get-reply-fast-path.js";
import { resolvePreparedReplyQueueState } from "./get-reply-run-queue.js";
import {
  buildDirectChatContext,
  buildGroupChatContext,
  buildGroupIntro,
  resolveGroupSilentReplyBehavior,
} from "./groups.js";
import { hasInboundMedia } from "./inbound-media.js";
import { buildInboundMetaSystemPrompt, buildInboundUserContextPrefix } from "./inbound-meta.js";
import type { createModelSelectionState } from "./model-selection.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { buildReplyPromptBodies } from "./prompt-prelude.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import { resolveQueueSettings } from "./queue/settings-runtime.js";
import { isSteeringQueueMode } from "./queue/steering.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";
import { resolveBareSessionResetPromptState } from "./session-reset-prompt.js";
import { resolveBareResetBootstrapFileAccess } from "./session-reset-prompt.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";
import { buildSessionStartupContextPrelude, shouldApplyStartupContext } from "./startup-context.js";
import { resolveTypingMode } from "./typing-mode.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";
import type { TypingController } from "./typing.js";

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];
type ExecOverrides = Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;

export function resolvePromptSilentReplyConversationType(params: {
  ctx: Pick<MsgContext, "ChatType" | "CommandSource" | "CommandTargetSessionKey" | "SessionKey">;
  inboundSessionKey?: string;
}): SilentReplyConversationType | undefined {
  const sourceSessionKey = params.inboundSessionKey ?? params.ctx.SessionKey;
  if (
    params.ctx.CommandSource === "native" &&
    params.ctx.CommandTargetSessionKey &&
    params.ctx.CommandTargetSessionKey !== sourceSessionKey
  ) {
    return undefined;
  }
  const chatType = normalizeChatType(params.ctx.ChatType);
  if (chatType === "direct") {
    return "direct";
  }
  if (chatType === "group" || chatType === "channel") {
    return "group";
  }
  return undefined;
}

function normalizePromptRouteChannel(raw?: string | null): string | undefined {
  const normalized = normalizeOptionalString(raw);
  return normalized && normalized !== "none" ? normalized : undefined;
}

function resolvePersistedPromptProvider(entry?: SessionEntry): string | undefined {
  return (
    normalizePromptRouteChannel(entry?.origin?.provider) ??
    normalizePromptRouteChannel(entry?.channel) ??
    normalizePromptRouteChannel(entry?.lastChannel) ??
    normalizePromptRouteChannel(entry?.deliveryContext?.channel)
  );
}

function resolvePersistedPromptSurface(entry?: SessionEntry): string | undefined {
  return (
    normalizePromptRouteChannel(entry?.origin?.surface) ?? resolvePersistedPromptProvider(entry)
  );
}

export function resolvePromptSessionContextForSystemEvent(params: {
  sessionCtx: TemplateContext;
  sessionEntry?: SessionEntry;
  ctx?: Pick<MsgContext, "Provider">;
  isHeartbeat?: boolean;
}): TemplateContext {
  const { sessionCtx, sessionEntry } = params;
  const isSystemEvent =
    params.isHeartbeat === true ||
    isSystemEventProvider(params.ctx?.Provider) ||
    isSystemEventProvider(sessionCtx.Provider);
  if (!isSystemEvent || !sessionEntry) {
    return sessionCtx;
  }

  const persistedChatType =
    normalizeChatType(sessionEntry.chatType) ?? normalizeChatType(sessionEntry.origin?.chatType);
  const liveChatType = normalizeChatType(sessionCtx.ChatType);
  const effectiveChatType = liveChatType ?? persistedChatType;
  const persistedProvider = resolvePersistedPromptProvider(sessionEntry);
  const persistedSurface = resolvePersistedPromptSurface(sessionEntry);
  const liveProvider = normalizeOptionalString(sessionCtx.Provider);
  const liveSurface = normalizeOptionalString(sessionCtx.Surface);
  const nextProvider =
    liveProvider && !isSystemEventProvider(liveProvider)
      ? liveProvider
      : (persistedProvider ?? liveProvider);
  const nextSurface =
    liveSurface && !isSystemEventProvider(liveSurface)
      ? liveSurface
      : (persistedSurface ?? liveSurface);

  const next: TemplateContext = { ...sessionCtx };
  let changed = false;
  const setIfMissing = <K extends keyof TemplateContext>(key: K, value: TemplateContext[K]) => {
    if (next[key] != null && next[key] !== "") {
      return;
    }
    if (value == null || value === "") {
      return;
    }
    next[key] = value;
    changed = true;
  };
  const setIfChanged = <K extends keyof TemplateContext>(key: K, value: TemplateContext[K]) => {
    if (value == null || value === "" || next[key] === value) {
      return;
    }
    next[key] = value;
    changed = true;
  };

  setIfChanged("Provider", nextProvider);
  setIfChanged("Surface", nextSurface);
  setIfMissing("ChatType", persistedChatType);
  if (effectiveChatType === "group" || effectiveChatType === "channel") {
    setIfMissing("GroupSubject", normalizeOptionalString(sessionEntry.subject));
    setIfMissing("GroupChannel", normalizeOptionalString(sessionEntry.groupChannel));
    setIfMissing("GroupSpace", normalizeOptionalString(sessionEntry.space));
  }
  setIfMissing("OriginatingChannel", persistedProvider);
  setIfMissing(
    "OriginatingTo",
    normalizeOptionalString(
      sessionEntry.lastTo ?? sessionEntry.deliveryContext?.to ?? sessionEntry.origin?.to,
    ),
  );
  setIfMissing(
    "AccountId",
    normalizeOptionalString(
      sessionEntry.lastAccountId ??
        sessionEntry.deliveryContext?.accountId ??
        sessionEntry.origin?.accountId,
    ),
  );
  setIfMissing(
    "MessageThreadId",
    sessionEntry.lastThreadId ??
      sessionEntry.deliveryContext?.threadId ??
      sessionEntry.origin?.threadId,
  );

  return changed ? next : sessionCtx;
}

export function buildExecOverridePromptHint(params: {
  execOverrides?: ExecOverrides;
  elevatedLevel: ElevatedLevel;
  fullAccessAvailable?: boolean;
  fullAccessBlockedReason?: EmbeddedFullAccessBlockedReason;
}): string | undefined {
  const exec = params.execOverrides;
  if (!exec && params.elevatedLevel === "off") {
    return undefined;
  }
  const parts = [
    exec?.host ? `host=${exec.host}` : undefined,
    exec?.security ? `security=${exec.security}` : undefined,
    exec?.ask ? `ask=${exec.ask}` : undefined,
    exec?.node ? `node=${exec.node}` : undefined,
  ].filter(Boolean);
  const execLine =
    parts.length > 0
      ? `Current session exec defaults: ${parts.join(" ")}.`
      : "Current session exec defaults: inherited from configured agent/global defaults.";
  const elevatedLine = `Current elevated level: ${params.elevatedLevel}.`;
  const fullAccessLine =
    params.fullAccessAvailable === false
      ? `Auto-approved /elevated full is unavailable here (${params.fullAccessBlockedReason ?? "runtime"}). Do not ask the user to switch to /elevated full.`
      : undefined;
  return [
    "## Current Exec Session State",
    execLine,
    elevatedLine,
    fullAccessLine,
    "If the user asks to run a command, use the current exec state above. Do not assume a prior denial still applies after `/exec` or `/elevated` changed.",
  ]
    .filter(Boolean)
    .join("\n");
}

const piEmbeddedRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/pi-embedded.runtime.js"),
);
const agentRunnerRuntimeLoader = createLazyImportLoader(() => import("./agent-runner.runtime.js"));
const sessionUpdatesRuntimeLoader = createLazyImportLoader(
  () => import("./session-updates.runtime.js"),
);
const sessionStoreRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/store.runtime.js"),
);
const UNTRUSTED_SYSTEM_EVENT_LINE_RE = /^System \(untrusted\):/m;

function loadPiEmbeddedRuntime() {
  return piEmbeddedRuntimeLoader.load();
}

function loadAgentRunnerRuntime() {
  return agentRunnerRuntimeLoader.load();
}

function loadSessionUpdatesRuntime() {
  return sessionUpdatesRuntimeLoader.load();
}

function loadSessionStoreRuntime() {
  return sessionStoreRuntimeLoader.load();
}

function stripPromptThinkingDirectives(body: string): string {
  return body
    .split("\n")
    .map((line) =>
      line
        .replace(/(^|\s)\/(?:thinking|think|t)(?=$|\s|:)(?:\s*:\s*|\s+)?[A-Za-z-]*/gi, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .trimEnd(),
    )
    .join("\n");
}

function hasInboundHistoryBody(ctx: TemplateContext): boolean {
  return (
    Array.isArray(ctx.InboundHistory) &&
    ctx.InboundHistory.some((entry) => entry.body.replaceAll("\u0000", "").trim().length > 0)
  );
}

type RunPreparedReplyParams = {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  sessionCfg: OpenClawConfig["session"];
  commandAuthorized: boolean;
  command: ReturnType<typeof buildCommandContext>;
  commandSource?: string;
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
    flushOnParagraph?: boolean;
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
  defaultProvider: string;
  defaultModel: string;
  timeoutMs: number;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId?: string;
  storePath?: string;
  workspaceDir: string;
  abortedLastRun: boolean;
};

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
    resetTriggered,
    systemSent,
    sessionKey,
    sessionId,
    storePath,
    workspaceDir,
    sessionStore,
  } = params;
  const runtimePolicySessionKey = resolveRuntimePolicySessionKey({
    cfg,
    ctx,
    sessionKey,
  });
  let {
    sessionEntry,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    abortedLastRun,
  } = params;
  const isHeartbeat = opts?.isHeartbeat === true;
  const promptSessionCtx = resolvePromptSessionContextForSystemEvent({
    sessionCtx,
    sessionEntry,
    ctx,
    isHeartbeat,
  });
  const silentReplyConversationType = resolvePromptSilentReplyConversationType({
    ctx: promptSessionCtx,
    inboundSessionKey: ctx.SessionKey,
  });
  const silentReplySettings = resolveSilentReplySettings({
    cfg,
    sessionKey: runtimePolicySessionKey,
    surface: promptSessionCtx.Surface ?? promptSessionCtx.Provider,
    conversationType: silentReplyConversationType,
  });
  const useFastReplyRuntime = shouldUseReplyFastTestRuntime({
    cfg,
    isFastTestEnv: process.env.OPENCLAW_TEST_FAST === "1",
  });
  const fullAccessState = resolveEmbeddedFullAccessState({
    execElevated: {
      enabled: elevatedEnabled,
      allowed: elevatedAllowed,
      defaultLevel: resolvedElevatedLevel ?? "off",
    },
  });
  let currentSystemSent = systemSent;

  const isFirstTurnInSession = isNewSession || !currentSystemSent;
  const isGroupChat =
    promptSessionCtx.ChatType === "group" || promptSessionCtx.ChatType === "channel";
  const isDirectChat = promptSessionCtx.ChatType === "direct" || promptSessionCtx.ChatType === "dm";
  const wasMentioned = ctx.WasMentioned === true;
  const { typingPolicy, suppressTyping } = resolveRunTypingPolicy({
    requestedPolicy: opts?.typingPolicy,
    suppressTyping: opts?.suppressTyping === true,
    isHeartbeat,
    originatingChannel: ctx.OriginatingChannel,
  });
  const typingMode = resolveTypingMode({
    configured: sessionCfg?.typingMode ?? agentCfg?.typingMode,
    isGroupChat,
    wasMentioned,
    isHeartbeat,
    typingPolicy,
    suppressTyping,
    sourceReplyDeliveryMode: opts?.sourceReplyDeliveryMode,
  });
  const shouldInjectGroupIntro = Boolean(
    isGroupChat && (isFirstTurnInSession || sessionEntry?.groupActivationNeedsSystemIntro),
  );
  const directChatContext = isDirectChat
    ? buildDirectChatContext({
        sessionCtx: promptSessionCtx,
        sourceReplyDeliveryMode: opts?.sourceReplyDeliveryMode,
        silentReplyPolicy: silentReplySettings.policy,
        silentReplyRewrite: silentReplySettings.rewrite,
        silentToken: SILENT_REPLY_TOKEN,
      })
    : "";
  // Always include persistent group chat context (provider + reply guidance).
  const groupChatContext = isGroupChat
    ? buildGroupChatContext({
        sessionCtx: promptSessionCtx,
        sourceReplyDeliveryMode: opts?.sourceReplyDeliveryMode,
        silentReplyPolicy: silentReplySettings.policy,
        silentReplyRewrite: silentReplySettings.rewrite,
        silentToken: SILENT_REPLY_TOKEN,
      })
    : "";
  // Behavioral intro (activation mode, lurking, etc.) only on first turn / activation needed
  const groupIntro = shouldInjectGroupIntro
    ? buildGroupIntro({
        cfg,
        sessionCtx: promptSessionCtx,
        sessionEntry,
        defaultActivation,
        silentToken: SILENT_REPLY_TOKEN,
        silentReplyPolicy: silentReplySettings.policy,
        silentReplyRewrite: silentReplySettings.rewrite,
      })
    : "";
  const allowEmptyAssistantReplyAsSilent =
    (isDirectChat &&
      silentReplyConversationType === "direct" &&
      silentReplySettings.policy === "allow") ||
    (isGroupChat &&
      resolveGroupSilentReplyBehavior({
        sessionEntry,
        defaultActivation,
        silentReplyPolicy: silentReplySettings.policy,
        silentReplyRewrite: silentReplySettings.rewrite,
      }).allowEmptyAssistantReplyAsSilent);
  const groupSystemPrompt = normalizeOptionalString(promptSessionCtx.GroupSystemPrompt) ?? "";
  const inboundMetaPrompt = buildInboundMetaSystemPrompt(
    isNewSession ? sessionCtx : { ...sessionCtx, ThreadStarterBody: undefined },
    { includeFormattingHints: !useFastReplyRuntime },
  );
  const extraSystemPromptParts = [
    inboundMetaPrompt,
    directChatContext,
    groupChatContext,
    groupIntro,
    groupSystemPrompt,
    buildExecOverridePromptHint({
      execOverrides,
      elevatedLevel: resolvedElevatedLevel,
      fullAccessAvailable: fullAccessState.available,
      fullAccessBlockedReason: fullAccessState.blockedReason,
    }),
  ].filter(Boolean);
  // Static parts only (no per-message inbound metadata) for CLI session reuse hashing.
  const extraSystemPromptStaticParts = [
    directChatContext,
    groupChatContext,
    groupIntro,
    groupSystemPrompt,
    buildExecOverridePromptHint({
      execOverrides,
      elevatedLevel: resolvedElevatedLevel,
      fullAccessAvailable: fullAccessState.available,
      fullAccessBlockedReason: fullAccessState.blockedReason,
    }),
  ].filter(Boolean);
  const silentReplyPromptMode: SilentReplyPromptMode =
    directChatContext || groupChatContext || opts?.sourceReplyDeliveryMode === "message_tool_only"
      ? "none"
      : "generic";
  const baseBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  // Use CommandBody/RawBody for bare reset detection (clean message without structural context).
  const rawBodyTrimmed = (ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "").trim();
  const baseBodyTrimmedRaw = baseBody.trim();
  const normalizedCommandBody = command.commandBodyNormalized.trim();
  const softResetTriggered = command.softResetTriggered === true;
  const softResetTail = command.softResetTail?.trim() ?? "";
  const effectiveResetTriggered = resetTriggered || softResetTriggered;
  const isWholeMessageCommand =
    normalizedCommandBody === rawBodyTrimmed ||
    normalizedCommandBody === rawBodyTrimmed.toLowerCase();
  const isResetOrNewCommand = /^\/(new|reset)(?:\s|$)/.test(normalizedCommandBody);
  if (
    allowTextCommands &&
    (!commandAuthorized || !command.isAuthorizedSender) &&
    isWholeMessageCommand &&
    (hasControlCommand(rawBodyTrimmed, cfg) || isResetOrNewCommand)
  ) {
    typing.cleanup();
    return undefined;
  }
  const isBareNewOrReset = /^\/(new|reset)$/.test(normalizedCommandBody);
  const isBareSessionReset =
    softResetTriggered ||
    (isNewSession &&
      ((baseBodyTrimmedRaw.length === 0 && rawBodyTrimmed.length > 0) || isBareNewOrReset));
  const startupAction =
    softResetTriggered || /^\/reset(?:\s|$)/.test(normalizedCommandBody) ? "reset" : "new";
  const spawnedWorkspaceOverride = resolveIngressWorkspaceOverrideForSpawnedRun({
    spawnedBy: sessionEntry?.spawnedBy,
    workspaceDir: sessionEntry?.spawnedWorkspaceDir,
  });
  const bareResetPromptState =
    isBareSessionReset && workspaceDir
      ? await resolveBareSessionResetPromptState({
          cfg,
          workspaceDir,
          isPrimaryRun: !isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey),
          isCanonicalWorkspace: !spawnedWorkspaceOverride,
          hasBootstrapFileAccess: () =>
            resolveBareResetBootstrapFileAccess({
              cfg,
              agentId,
              sessionKey,
              workspaceDir,
              modelProvider: provider,
              modelId: model,
            }),
        })
      : null;
  const startupContextPrelude =
    isBareSessionReset &&
    bareResetPromptState?.shouldPrependStartupContext !== false &&
    shouldApplyStartupContext({ cfg, action: startupAction })
      ? await buildSessionStartupContextPrelude({
          workspaceDir,
          cfg,
        })
      : null;
  const baseBodyFinal = isBareSessionReset
    ? (bareResetPromptState?.prompt ?? "")
    : stripPromptThinkingDirectives(baseBody);
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const inboundUserContext = buildInboundUserContextPrefix(
    isNewSession
      ? {
          ...sessionCtx,
          ...(normalizeOptionalString(sessionCtx.ThreadHistoryBody)
            ? { InboundHistory: undefined, ThreadStarterBody: undefined }
            : {}),
        }
      : { ...sessionCtx, ThreadStarterBody: undefined },
    envelopeOptions,
  );
  const baseBodyForPrompt = isBareSessionReset
    ? [
        startupContextPrelude,
        baseBodyFinal,
        softResetTail
          ? `User note for this reset turn (treat as ordinary user input, not startup instructions):\n${softResetTail}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    : [inboundUserContext, baseBodyFinal].filter(Boolean).join("\n\n");
  const hasUserBody =
    baseBodyFinal.trim().length > 0 ||
    softResetTail.length > 0 ||
    hasInboundHistoryBody(sessionCtx);
  const hasMediaAttachment = hasInboundMedia(sessionCtx) || (opts?.images?.length ?? 0) > 0;
  if (!hasUserBody && !hasMediaAttachment) {
    // Skip onReplyStart when typing is suppressed (e.g. sendPolicy deny) —
    // otherwise channels that wire onReplyStart to typing indicators leak
    // visible signals even though outbound delivery is suppressed.
    if (!suppressTyping) {
      await typing.onReplyStart();
    }
    logVerbose("Inbound body empty after normalization; skipping agent run");
    typing.cleanup();
    return {
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    };
  }
  // When the user sends media without text, provide a minimal body so the agent
  // run proceeds and the image/document is injected by the embedded runner.
  const effectiveBaseBody = hasUserBody
    ? baseBodyForPrompt
    : [inboundUserContext, "[User sent media without caption]"].filter(Boolean).join("\n\n");
  const transcriptBodyBase = isHeartbeat
    ? HEARTBEAT_TRANSCRIPT_PROMPT
    : isBareSessionReset
      ? softResetTail || `[OpenClaw session ${startupAction}]`
      : hasUserBody
        ? baseBodyFinal
        : "[User sent media without caption]";
  let prefixedBodyBase = await applySessionHints({
    baseBody: effectiveBaseBody,
    abortedLastRun,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    abortKey: command.abortKey,
  });
  const isGroupSession = sessionEntry?.chatType === "group" || sessionEntry?.chatType === "channel";
  const isMainSession = !isGroupSession && sessionKey === normalizeMainKey(sessionCfg?.mainKey);
  // Extract first-token think hint from the user body BEFORE prepending system events.
  // If done after, the System: prefix becomes parts[0] and silently shadows any
  // low|medium|high shorthand the user typed.
  if (!resolvedThinkLevel && prefixedBodyBase) {
    const parts = prefixedBodyBase.split(/\s+/);
    const maybeLevel = normalizeThinkLevel(parts[0]);
    const thinkingCatalog = maybeLevel ? await modelState.resolveThinkingCatalog() : undefined;
    if (
      maybeLevel &&
      isThinkingLevelSupported({ provider, model, level: maybeLevel, catalog: thinkingCatalog })
    ) {
      resolvedThinkLevel = maybeLevel;
      prefixedBodyBase = parts.slice(1).join(" ").trim();
    }
  }
  const prefixedBodyCore = prefixedBodyBase;
  const threadStarterBody = normalizeOptionalString(ctx.ThreadStarterBody);
  const threadHistoryBody = normalizeOptionalString(ctx.ThreadHistoryBody);
  const threadContextNote = threadHistoryBody
    ? `[Thread history - for context]\n${threadHistoryBody}`
    : !isNewSession && threadStarterBody
      ? `[Thread starter - for context]\n${threadStarterBody}`
      : undefined;
  const drainedSystemEventBlocks: string[] = [];
  let forceSenderIsOwnerFalseFromSystemEvents = false;
  const rebuildPromptBodies = async (): Promise<{
    prefixedCommandBody: string;
    queuedBody: string;
    transcriptCommandBody: string;
  }> => {
    if (!useFastReplyRuntime) {
      const eventsBlock = await drainFormattedSystemEvents({
        cfg,
        sessionKey,
        isMainSession,
        isNewSession,
      });
      if (eventsBlock) {
        drainedSystemEventBlocks.push(eventsBlock);
        if (UNTRUSTED_SYSTEM_EVENT_LINE_RE.test(eventsBlock)) {
          forceSenderIsOwnerFalseFromSystemEvents = true;
        }
      }
    }
    return buildReplyPromptBodies({
      ctx,
      sessionCtx,
      effectiveBaseBody,
      prefixedBody: prefixedBodyCore,
      transcriptBody: transcriptBodyBase,
      threadContextNote,
      systemEventBlocks: drainedSystemEventBlocks,
    });
  };
  const skillResult =
    process.env.OPENCLAW_TEST_FAST === "1"
      ? {
          sessionEntry,
          skillsSnapshot: sessionEntry?.skillsSnapshot,
          systemSent: currentSystemSent,
        }
      : await (async () => {
          const { ensureSkillSnapshot } = await loadSessionUpdatesRuntime();
          return ensureSkillSnapshot({
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
        })();
  sessionEntry = skillResult.sessionEntry ?? sessionEntry;
  currentSystemSent = skillResult.systemSent;
  const skillsSnapshot = skillResult.skillsSnapshot;
  let { prefixedCommandBody, queuedBody, transcriptCommandBody } = await rebuildPromptBodies();
  if (!resolvedThinkLevel) {
    resolvedThinkLevel = await modelState.resolveDefaultThinkingLevel();
  }
  const thinkingCatalog = await modelState.resolveThinkingCatalog();
  if (
    !isThinkingLevelSupported({
      provider,
      model,
      level: resolvedThinkLevel,
      catalog: thinkingCatalog,
    })
  ) {
    const explicitThink = directives.hasThinkDirective && directives.thinkLevel !== undefined;
    if (explicitThink) {
      typing.cleanup();
      return {
        text: `Thinking level "${resolvedThinkLevel}" is not supported for ${provider}/${model}. Use one of: ${formatThinkingLevels(provider, model, ", ", thinkingCatalog)}.`,
      };
    }
    const fallbackThinkLevel = resolveSupportedThinkingLevel({
      provider,
      model,
      level: resolvedThinkLevel,
      catalog: thinkingCatalog,
    });
    if (fallbackThinkLevel !== resolvedThinkLevel) {
      const previousThinkLevel = resolvedThinkLevel;
      resolvedThinkLevel = fallbackThinkLevel;
      if (
        sessionEntry &&
        sessionStore &&
        sessionKey &&
        sessionEntry.thinkingLevel === previousThinkLevel
      ) {
        sessionEntry.thinkingLevel = fallbackThinkLevel;
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        if (storePath) {
          const { updateSessionStore } = await loadSessionStoreRuntime();
          await updateSessionStore(storePath, (store) => {
            store[sessionKey] = sessionEntry;
          });
        }
      }
    }
  }
  const sessionIdFinal = sessionId ?? crypto.randomUUID();
  const sessionFilePathOptions = resolveSessionFilePathOptions({ agentId, storePath });
  const resolvePreparedSessionState = (): {
    sessionEntry: SessionEntry | undefined;
    sessionId: string;
    sessionFile: string;
  } => {
    const latestSessionEntry =
      sessionStore && sessionKey
        ? (resolveSessionStoreEntry({
            store: sessionStore,
            sessionKey,
          }).existing ?? sessionEntry)
        : sessionEntry;
    const latestSessionId = latestSessionEntry?.sessionId ?? sessionIdFinal;
    return {
      sessionEntry: latestSessionEntry,
      sessionId: latestSessionId,
      sessionFile: resolveSessionFilePath(
        latestSessionId,
        latestSessionEntry,
        sessionFilePathOptions,
      ),
    };
  };
  let preparedSessionState = resolvePreparedSessionState();
  const resolvedQueue = useFastReplyRuntime
    ? {
        mode: "collect" as const,
        debounceMs: 0,
        cap: 1,
        dropPolicy: "summarize" as const,
      }
    : resolveQueueSettings({
        cfg,
        channel: sessionCtx.Provider,
        sessionEntry,
        inlineMode: perMessageQueueMode,
        inlineOptions: perMessageQueueOptions,
      });
  const piRuntime = useFastReplyRuntime ? null : await loadPiEmbeddedRuntime();
  const sessionLaneKey = piRuntime
    ? piRuntime.resolveEmbeddedSessionLane(sessionKey ?? sessionIdFinal)
    : undefined;
  const laneSize = sessionLaneKey ? getQueueSize(sessionLaneKey) : 0;
  const activeRunQueueMode = effectiveResetTriggered ? "interrupt" : resolvedQueue.mode;
  const activeSessionIdForInterrupt = piRuntime?.resolveActiveEmbeddedRunSessionId(sessionKey);
  if (
    activeRunQueueMode === "interrupt" &&
    sessionLaneKey &&
    (laneSize > 0 || activeSessionIdForInterrupt)
  ) {
    const cleared = clearCommandLane(sessionLaneKey);
    const aborted = piRuntime?.abortEmbeddedPiRun(
      activeSessionIdForInterrupt ?? preparedSessionState.sessionId,
    );
    logVerbose(`Interrupting ${sessionLaneKey} (cleared ${cleared}, aborted=${aborted})`);
  }
  let authProfileId = useFastReplyRuntime
    ? preparedSessionState.sessionEntry?.authProfileOverride
    : await resolveSessionAuthProfileOverride({
        cfg,
        provider,
        agentDir,
        sessionEntry: preparedSessionState.sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        isNewSession,
      });
  const { runReplyAgent } = await loadAgentRunnerRuntime();
  const queueKey = sessionKey ?? sessionIdFinal;
  preparedSessionState = resolvePreparedSessionState();
  const resolveActiveQueueSessionId = () =>
    piRuntime?.resolveActiveEmbeddedRunSessionId(sessionKey) ?? preparedSessionState.sessionId;
  const resolveQueueBusyState = () => {
    const activeSessionId = resolveActiveQueueSessionId();
    if (!activeSessionId || !piRuntime) {
      return { activeSessionId: undefined, isActive: false, isStreaming: false };
    }
    return {
      activeSessionId,
      isActive: piRuntime.isEmbeddedPiRunActive(activeSessionId),
      isStreaming: piRuntime.isEmbeddedPiRunStreaming(activeSessionId),
    };
  };
  let { activeSessionId, isActive, isStreaming } = resolveQueueBusyState();
  const shouldSteer = !effectiveResetTriggered && isSteeringQueueMode(resolvedQueue.mode);
  const shouldFollowup =
    !effectiveResetTriggered &&
    (resolvedQueue.mode === "followup" ||
      resolvedQueue.mode === "collect" ||
      resolvedQueue.mode === "steer-backlog");
  const activeRunQueueAction = resolveActiveRunQueueAction({
    isActive,
    isHeartbeat: opts?.isHeartbeat === true,
    shouldFollowup,
    queueMode: activeRunQueueMode,
    resetTriggered: effectiveResetTriggered,
  });
  if (isActive && activeRunQueueAction === "run-now") {
    const queueState = await resolvePreparedReplyQueueState({
      activeRunQueueAction,
      activeSessionId: activeSessionId ?? resolveActiveQueueSessionId(),
      queueMode: activeRunQueueMode,
      sessionKey,
      sessionId: sessionIdFinal,
      abortActiveRun: (activeRunSessionId) =>
        piRuntime?.abortEmbeddedPiRun(activeRunSessionId) ?? false,
      waitForActiveRunEnd: (activeRunSessionId) =>
        piRuntime?.waitForEmbeddedPiRunEnd(activeRunSessionId) ?? Promise.resolve(undefined),
      refreshPreparedState: async () => {
        preparedSessionState = resolvePreparedSessionState();
        authProfileId = useFastReplyRuntime
          ? preparedSessionState.sessionEntry?.authProfileOverride
          : await resolveSessionAuthProfileOverride({
              cfg,
              provider,
              agentDir,
              sessionEntry: preparedSessionState.sessionEntry,
              sessionStore,
              sessionKey,
              storePath,
              isNewSession,
            });
        preparedSessionState = resolvePreparedSessionState();
        ({ prefixedCommandBody, queuedBody, transcriptCommandBody } = await rebuildPromptBodies());
      },
      resolveBusyState: resolveQueueBusyState,
    });
    if (queueState.kind === "reply") {
      typing.cleanup();
      return queueState.reply;
    }
    ({ activeSessionId, isActive, isStreaming } = queueState.busyState);
  }
  const authProfileIdSource = preparedSessionState.sessionEntry?.authProfileOverrideSource;
  const runHasSessionModelOverride = Boolean(
    normalizeOptionalString(preparedSessionState.sessionEntry?.modelOverride) ||
    normalizeOptionalString(preparedSessionState.sessionEntry?.providerOverride),
  );
  const followupRun = {
    prompt: queuedBody,
    transcriptPrompt: transcriptCommandBody,
    messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
    summaryLine: baseBodyTrimmedRaw,
    enqueuedAt: Date.now(),
    images: opts?.images,
    imageOrder: opts?.imageOrder,
    // Originating channel for reply routing.
    originatingChannel: ctx.OriginatingChannel,
    originatingTo: ctx.OriginatingTo,
    originatingAccountId: sessionCtx.AccountId,
    originatingThreadId: ctx.MessageThreadId,
    originatingChatType: ctx.ChatType,
    run: {
      agentId,
      agentDir,
      sessionId: preparedSessionState.sessionId,
      sessionKey,
      runtimePolicySessionKey,
      messageProvider: resolveOriginMessageProvider({
        originatingChannel: ctx.OriginatingChannel ?? sessionCtx.OriginatingChannel,
        // Prefer Provider over Surface for fallback channel identity.
        // Surface can carry relayed metadata (for example "webchat") while Provider
        // still reflects the active channel that should own tool routing.
        provider: ctx.Provider ?? ctx.Surface ?? sessionCtx.Provider,
      }),
      agentAccountId: sessionCtx.AccountId,
      groupId: resolveGroupSessionKey(sessionCtx)?.id ?? undefined,
      groupChannel:
        normalizeOptionalString(sessionCtx.GroupChannel) ??
        normalizeOptionalString(sessionCtx.GroupSubject),
      groupSpace: normalizeOptionalString(sessionCtx.GroupSpace),
      senderId: normalizeOptionalString(sessionCtx.SenderId),
      senderName: normalizeOptionalString(sessionCtx.SenderName),
      senderUsername: normalizeOptionalString(sessionCtx.SenderUsername),
      senderE164: normalizeOptionalString(sessionCtx.SenderE164),
      senderIsOwner: forceSenderIsOwnerFalseFromSystemEvents ? false : command.senderIsOwner,
      traceAuthorized:
        (forceSenderIsOwnerFalseFromSystemEvents ? false : command.senderIsOwner) ||
        (ctx.GatewayClientScopes ?? []).includes("operator.admin"),
      sessionFile: preparedSessionState.sessionFile,
      workspaceDir,
      config: cfg,
      skillsSnapshot,
      provider,
      model,
      hasSessionModelOverride: runHasSessionModelOverride,
      modelOverrideSource: runHasSessionModelOverride
        ? preparedSessionState.sessionEntry?.modelOverrideSource
        : undefined,
      authProfileId,
      authProfileIdSource,
      thinkLevel: resolvedThinkLevel,
      fastMode: useFastReplyRuntime
        ? false
        : resolveFastModeState({
            cfg,
            provider,
            model,
            agentId,
            sessionEntry: preparedSessionState.sessionEntry,
          }).enabled,
      verboseLevel: resolvedVerboseLevel,
      reasoningLevel: resolvedReasoningLevel,
      elevatedLevel: resolvedElevatedLevel,
      execOverrides,
      bashElevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        defaultLevel: resolvedElevatedLevel ?? "off",
        fullAccessAvailable: fullAccessState.available,
        ...(fullAccessState.blockedReason
          ? { fullAccessBlockedReason: fullAccessState.blockedReason }
          : {}),
      },
      timeoutMs,
      blockReplyBreak: resolvedBlockStreamingBreak,
      ownerNumbers: command.ownerList.length > 0 ? command.ownerList : undefined,
      inputProvenance: ctx.InputProvenance ?? sessionCtx.InputProvenance,
      extraSystemPrompt: extraSystemPromptParts.join("\n\n") || undefined,
      sourceReplyDeliveryMode: opts?.sourceReplyDeliveryMode,
      silentReplyPromptMode,
      extraSystemPromptStatic: extraSystemPromptStaticParts.join("\n\n"),
      skipProviderRuntimeHints: useFastReplyRuntime,
      allowEmptyAssistantReplyAsSilent,
      ...(!useFastReplyRuntime &&
      isReasoningTagProvider(provider, {
        config: cfg,
        workspaceDir,
        modelId: model,
      })
        ? { enforceFinalTag: true }
        : {}),
    },
  };

  const replyThreadingOverride =
    isBareSessionReset && sessionCtx.ReplyThreading?.implicitCurrentMessage !== "deny"
      ? {
          ...sessionCtx.ReplyThreading,
          implicitCurrentMessage: "deny" as const,
        }
      : undefined;

  return runReplyAgent({
    commandBody: prefixedCommandBody,
    transcriptCommandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isRunActive: () => {
      const latestSessionState = resolvePreparedSessionState();
      const latestActiveSessionId =
        piRuntime?.resolveActiveEmbeddedRunSessionId(sessionKey) ?? latestSessionState.sessionId;
      return piRuntime?.isEmbeddedPiRunActive(latestActiveSessionId) ?? false;
    },
    isStreaming,
    opts,
    typing,
    sessionEntry: preparedSessionState.sessionEntry,
    sessionStore,
    sessionKey,
    runtimePolicySessionKey,
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
    resetTriggered: effectiveResetTriggered,
    replyThreadingOverride,
  });
}
