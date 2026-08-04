import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddedFullAccessBlockedReason } from "../../agents/embedded-agent-runner/types.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { updateAmbientTranscriptWatermark } from "../../config/sessions/ambient-transcript-watermark.js";
import type { PendingSkillSuggestion, SessionEntry } from "../../config/sessions/types.js";
import { isImageMediaFact, type MediaFact } from "../../media/media-facts.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { ElevatedLevel } from "../thinking.js";
import { isSystemEventProvider } from "./effective-reply-route.js";
import type { ExecOverrides } from "./get-reply-run.types.js";
import {
  resolvePersistedPromptProvider,
  resolvePersistedPromptSurface,
} from "./prompt-session-context.js";

const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

export function buildPersistedMediaImageLayout(params: {
  ctx: MsgContext;
  media: readonly MediaFact[];
  ctxMediaCount: number;
  imageOrder?: readonly ("inline" | "offloaded")[];
  imageSourceIndexes?: readonly (number | undefined)[];
}): NonNullable<UserTurnInput["mediaImageLayout"]> | undefined {
  const describedAttachmentIndexes = new Set(
    params.ctx.MediaUnderstanding?.flatMap((output) =>
      output.kind === "image.description" ? [output.attachmentIndex] : [],
    ) ?? [],
  );
  const suppressedFactIndexes: number[] = [];
  const imageFactIndexes: number[] = [];
  for (const [factIndex, fact] of params.media.entries()) {
    if (!isImageMediaFact(fact)) {
      continue;
    }
    imageFactIndexes.push(factIndex);
    if (
      (factIndex < params.ctxMediaCount && describedAttachmentIndexes.has(factIndex)) ||
      fact.hydrationSuppressed === true
    ) {
      suppressedFactIndexes.push(factIndex);
    }
  }
  if (imageFactIndexes.length === 0) {
    return undefined;
  }
  const suppressed = new Set(suppressedFactIndexes);
  const used = new Set<number>();
  const unsuppressedFactCount = imageFactIndexes.filter((index) => !suppressed.has(index)).length;
  const canInferByPosition = unsuppressedFactCount === (params.imageOrder?.length ?? 0);
  const takeNextFactIndex = (): number | undefined =>
    imageFactIndexes.find((index) => !suppressed.has(index) && !used.has(index));
  const slots = (params.imageOrder ?? []).map((kind, index) => {
    const sourceIndex = params.imageSourceIndexes?.[index];
    const sourceFact = sourceIndex === undefined ? undefined : params.media[sourceIndex];
    const factIndex =
      sourceIndex !== undefined
        ? sourceFact &&
          isImageMediaFact(sourceFact) &&
          !suppressed.has(sourceIndex) &&
          !used.has(sourceIndex)
          ? sourceIndex
          : undefined
        : canInferByPosition
          ? takeNextFactIndex()
          : undefined;
    if (factIndex !== undefined) {
      used.add(factIndex);
    }
    return factIndex === undefined ? { kind } : { kind, factIndex };
  });
  for (const factIndex of imageFactIndexes) {
    if (!suppressed.has(factIndex) && !used.has(factIndex)) {
      slots.push({ kind: "offloaded", factIndex });
    }
  }
  if (slots.length === 0 && suppressedFactIndexes.length === 0) {
    return undefined;
  }
  return {
    slots,
    ...(suppressedFactIndexes.length > 0 ? { suppressedFactIndexes } : {}),
  };
}

export function routeThreadIdsMatch(
  activeThreadId: string | number | undefined,
  currentThreadId: string | number | undefined,
): boolean {
  if (activeThreadId === undefined || currentThreadId === undefined) {
    return true;
  }
  return String(activeThreadId) === String(currentThreadId);
}

export function normalizeMessageTimestampMs(value: unknown): number | undefined {
  const timestamp = typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  const timestampMs =
    timestamp < EPOCH_MILLISECONDS_THRESHOLD ? Math.trunc(timestamp * 1000) : timestamp;
  return asDateTimestampMs(timestampMs);
}

export function projectSkillSuggestionForTurn(
  entry: SessionEntry | undefined,
  suggestion: PendingSkillSuggestion | undefined,
): SessionEntry | undefined {
  if (!entry) {
    return undefined;
  }
  if (suggestion) {
    return { ...entry, pendingSkillSuggestion: suggestion };
  }
  if (!entry.pendingSkillSuggestion) {
    return entry;
  }
  const projected = { ...entry };
  delete projected.pendingSkillSuggestion;
  return projected;
}

export async function updateRoomEventAmbientTranscriptWatermark(params: {
  expectedSessionId: string;
  sessionCtx: TemplateContext;
  storePath?: string;
  sessionKey?: string;
}): Promise<void> {
  const key = normalizeOptionalString(params.sessionCtx.AmbientTranscriptWatermarkKey);
  const messageId = normalizeOptionalString(params.sessionCtx.AmbientTranscriptMessageId);
  if (!params.storePath || !params.sessionKey || !key || !messageId) {
    return;
  }
  // Advance only after the transcript row exists; Telegram windows exclude
  // everything at or before this durable boundary on later turns.
  await updateAmbientTranscriptWatermark({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    key,
    messageId,
    timestampMs: params.sessionCtx.AmbientTranscriptTimestampMs,
    expectedSessionId: params.expectedSessionId,
  });
}

export function resolvePromptSilentReplyConversationType(params: {
  ctx: Pick<
    MsgContext,
    "ChatType" | "CommandSource" | "CommandTargetSessionKey" | "CommandTurn" | "SessionKey"
  >;
  inboundSessionKey?: string;
}): SilentReplyConversationType | undefined {
  const sourceSessionKey = params.inboundSessionKey ?? params.ctx.SessionKey;
  const commandTargetSessionKey = resolveCommandTurnTargetSessionKey(params.ctx);
  if (commandTargetSessionKey && commandTargetSessionKey !== sourceSessionKey) {
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

  const origin = sessionDeliveryOrigin(sessionEntry);
  const deliveryContext = deliveryContextFromSession(sessionEntry);
  const persistedChatType =
    normalizeChatType(sessionEntry.chatType) ?? normalizeChatType(origin?.chatType);
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
  setIfMissing("OriginatingTo", normalizeOptionalString(deliveryContext?.to ?? origin?.to));
  setIfMissing(
    "AccountId",
    normalizeOptionalString(deliveryContext?.accountId ?? origin?.accountId),
  );
  setIfMissing("MessageThreadId", deliveryContext?.threadId ?? origin?.threadId);

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

const embeddedAgentRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/embedded-agent.runtime.js"),
);
const agentRunnerRuntimeLoader = createLazyImportLoader(() => import("./agent-runner.runtime.js"));
const sessionUpdatesRuntimeLoader = createLazyImportLoader(
  () => import("./session-updates.runtime.js"),
);

export function loadEmbeddedAgentRuntime() {
  return embeddedAgentRuntimeLoader.load();
}

export function loadAgentRunnerRuntime() {
  return agentRunnerRuntimeLoader.load();
}

export function loadSessionUpdatesRuntime() {
  return sessionUpdatesRuntimeLoader.load();
}

export function stripPromptThinkingDirectives(body: string): string {
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

export function hasInboundHistoryBody(ctx: TemplateContext): boolean {
  return (
    Array.isArray(ctx.InboundHistory) &&
    ctx.InboundHistory.some((entry) => entry.body.replaceAll("\u0000", "").trim().length > 0)
  );
}

export function hasReplyTargetContext(ctx: MsgContext | TemplateContext): boolean {
  if (normalizeOptionalString(ctx.ReplyToBody)) {
    return true;
  }
  const replyChain = (ctx as { ReplyChain?: unknown }).ReplyChain;
  return Array.isArray(replyChain) && replyChain.length > 0;
}
