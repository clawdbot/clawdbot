import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type {
  ContextEnginePromptCacheInfo,
  ContextEngineRuntimeContext,
} from "../../../context-engine/types.js";
import { drainPluginNextTurnInjectionContext } from "../../../plugins/host-hook-state.js";
import { buildPluginAgentTurnPrepareContext } from "../../../plugins/host-hooks.js";
import type {
  PluginAgentTurnPrepareResult,
  PluginNextTurnInjectionRecord,
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
} from "../../../plugins/types.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { listActiveProcessSessionReferences } from "../../bash-process-references.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../../heartbeat-system-prompt.js";
import { buildActiveImageGenerationTaskPromptContextForSession } from "../../image-generation-task-status.js";
import { buildActiveMusicGenerationTaskPromptContextForSession } from "../../music-generation-task-status.js";
import { resolveProcessToolScopeKey } from "../../pi-tools.js";
import { prependSystemPromptAdditionAfterCacheBoundary } from "../../system-prompt-cache-boundary.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../tool-fs-policy.js";
import { derivePromptTokens, type NormalizedUsage } from "../../usage.js";
import { buildActiveVideoGenerationTaskPromptContextForSession } from "../../video-generation-task-status.js";
import { buildEmbeddedCompactionRuntimeContext } from "../compaction-runtime-context.js";
import { resolveContextEngineCapabilities } from "../context-engine-capabilities.js";
import { log } from "../logger.js";
import { shouldInjectHeartbeatPromptForTrigger } from "./trigger-policy.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type PromptBuildHookRunner = {
  hasHooks: (
    hookName:
      | "agent_turn_prepare"
      | "heartbeat_prompt_contribution"
      | "before_prompt_build"
      | "before_agent_start",
  ) => boolean;
  runAgentTurnPrepare?: (
    event: {
      prompt: string;
      messages: unknown[];
      queuedInjections: PluginNextTurnInjectionRecord[];
    },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginAgentTurnPrepareResult | undefined>;
  runHeartbeatPromptContribution?: (
    event: { sessionKey?: string; agentId?: string; heartbeatName?: string },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginAgentTurnPrepareResult | undefined>;
  runBeforePromptBuild: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforePromptBuildResult | undefined>;
  runBeforeAgentStart: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforeAgentStartResult | undefined>;
};

// Cache drained next-turn injections by runId so retry attempts within the
// same run reuse the first-attempt drain rather than calling drain again
// (which destructively consumes from the session store and would return [] on
// retry, dropping injection context). The cache is bounded to keep memory flat
// across long-lived processes; entries are evicted FIFO once the cap is hit.
const PROMPT_BUILD_DRAIN_CACHE_MAX = 256;
const promptBuildDrainCache = new Map<string, PluginNextTurnInjectionRecord[]>();

function rememberDrainedInjections(
  runId: string,
  injections: PluginNextTurnInjectionRecord[],
): void {
  if (promptBuildDrainCache.has(runId)) {
    promptBuildDrainCache.delete(runId);
  } else if (promptBuildDrainCache.size >= PROMPT_BUILD_DRAIN_CACHE_MAX) {
    const oldest = promptBuildDrainCache.keys().next().value;
    if (oldest !== undefined) {
      promptBuildDrainCache.delete(oldest);
    }
  }
  promptBuildDrainCache.set(runId, injections);
}

/**
 * Releases the per-run drained-injection cache. Call when a run terminates so
 * the cap stays headroom for active runs.
 */
export function forgetPromptBuildDrainCacheForRun(runId: string | undefined): void {
  if (runId) {
    promptBuildDrainCache.delete(runId);
  }
}

export async function resolvePromptBuildHookResult(params: {
  config: OpenClawConfig;
  prompt: string;
  messages: unknown[];
  hookCtx: PluginHookAgentContext;
  hookRunner?: PromptBuildHookRunner | null;
  legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
}): Promise<PluginHookBeforePromptBuildResult> {
  const runId = params.hookCtx.runId;
  const cachedInjections = runId ? promptBuildDrainCache.get(runId) : undefined;
  const queuedContext = cachedInjections
    ? {
        queuedInjections: cachedInjections,
        ...buildPluginAgentTurnPrepareContext({ queuedInjections: cachedInjections }),
      }
    : await drainPluginNextTurnInjectionContext({
        cfg: params.config,
        sessionKey: params.hookCtx.sessionKey,
      });
  if (runId && !cachedInjections) {
    rememberDrainedInjections(runId, queuedContext.queuedInjections);
  }
  const turnPrepareResult =
    params.hookRunner?.runAgentTurnPrepare && params.hookRunner.hasHooks("agent_turn_prepare")
      ? await params.hookRunner
          .runAgentTurnPrepare(
            {
              prompt: params.prompt,
              messages: params.messages,
              queuedInjections: queuedContext.queuedInjections,
            },
            params.hookCtx,
          )
          .catch((hookErr: unknown) => {
            log.warn(`agent_turn_prepare hook failed: ${String(hookErr)}`);
            return undefined;
          })
      : undefined;
  const heartbeatContribution =
    params.hookCtx.trigger === "heartbeat" &&
    params.hookRunner?.runHeartbeatPromptContribution &&
    params.hookRunner.hasHooks("heartbeat_prompt_contribution")
      ? await params.hookRunner
          .runHeartbeatPromptContribution(
            {
              sessionKey: params.hookCtx.sessionKey,
              agentId: params.hookCtx.agentId,
              heartbeatName: "heartbeat",
            },
            params.hookCtx,
          )
          .catch((hookErr: unknown) => {
            log.warn(`heartbeat_prompt_contribution hook failed: ${String(hookErr)}`);
            return undefined;
          })
      : undefined;
  const promptBuildResult = params.hookRunner?.hasHooks("before_prompt_build")
    ? await params.hookRunner
        .runBeforePromptBuild(
          {
            prompt: params.prompt,
            messages: params.messages,
          },
          params.hookCtx,
        )
        .catch((hookErr: unknown) => {
          log.warn(`before_prompt_build hook failed: ${String(hookErr)}`);
          return undefined;
        })
    : undefined;
  const legacyResult =
    params.legacyBeforeAgentStartResult ??
    (params.hookRunner?.hasHooks("before_agent_start")
      ? await params.hookRunner
          .runBeforeAgentStart(
            {
              prompt: params.prompt,
              messages: params.messages,
            },
            params.hookCtx,
          )
          .catch((hookErr: unknown) => {
            log.warn(
              `before_agent_start hook (legacy prompt build path) failed: ${String(hookErr)}`,
            );
            return undefined;
          })
      : undefined);
  return {
    systemPrompt: promptBuildResult?.systemPrompt ?? legacyResult?.systemPrompt,
    prependContext: joinPresentTextSegments([
      queuedContext.prependContext,
      turnPrepareResult?.prependContext,
      heartbeatContribution?.prependContext,
      promptBuildResult?.prependContext,
      legacyResult?.prependContext,
    ]),
    appendContext: joinPresentTextSegments([
      queuedContext.appendContext,
      turnPrepareResult?.appendContext,
      heartbeatContribution?.appendContext,
      promptBuildResult?.appendContext,
      legacyResult?.appendContext,
    ]),
    prependSystemContext: joinPresentTextSegments([
      promptBuildResult?.prependSystemContext,
      legacyResult?.prependSystemContext,
    ]),
    appendSystemContext: joinPresentTextSegments([
      promptBuildResult?.appendSystemContext,
      legacyResult?.appendSystemContext,
    ]),
  };
}

export function resolvePromptModeForSession(sessionKey?: string): "minimal" | "full" {
  if (!sessionKey) {
    return "full";
  }
  return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) ? "minimal" : "full";
}

export function shouldInjectHeartbeatPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  defaultAgentId?: string;
  isDefaultAgent: boolean;
  trigger?: EmbeddedRunAttemptParams["trigger"];
}): boolean {
  return (
    params.isDefaultAgent &&
    shouldInjectHeartbeatPromptForTrigger(params.trigger) &&
    Boolean(
      resolveHeartbeatPromptForSystemPrompt({
        config: params.config,
        agentId: params.agentId,
        defaultAgentId: params.defaultAgentId,
      }),
    )
  );
}

export function shouldWarnOnOrphanedUserRepair(
  trigger: EmbeddedRunAttemptParams["trigger"],
): boolean {
  return trigger === "user" || trigger === "manual";
}

export type PromptSubmissionSkipReason = "blank_user_prompt" | "empty_prompt_history_images";

export function resolvePromptSubmissionSkipReason(params: {
  prompt: string;
  messages: readonly unknown[];
  imageCount: number;
  runtimeOnly?: boolean;
}): PromptSubmissionSkipReason | null {
  if (params.prompt.trim().length > 0 || params.imageCount > 0) {
    return null;
  }
  return params.messages.length > 0 ? "blank_user_prompt" : "empty_prompt_history_images";
}

const QUEUED_USER_MESSAGE_MARKER =
  "[Queued user message that arrived while the previous turn was still active]";
const MAX_STRUCTURED_MEDIA_REF_CHARS = 300;
const MAX_STRUCTURED_JSON_STRING_CHARS = 300;
const MAX_STRUCTURED_JSON_DEPTH = 4;
const MAX_STRUCTURED_JSON_ARRAY_ITEMS = 16;
const MAX_STRUCTURED_JSON_OBJECT_KEYS = 32;

function summarizeStructuredMediaRef(label: string, value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const dataUriMatch = trimmed.match(/^data:([^;,]+)?(?:;[^,]*)?,/i);
  if (dataUriMatch) {
    const mimeType = dataUriMatch[1]?.trim() || "unknown";
    return `[${label}] inline data URI (${mimeType}, ${trimmed.length} chars)`;
  }
  if (trimmed.length > MAX_STRUCTURED_MEDIA_REF_CHARS) {
    return `[${label}] ${trimmed.slice(0, MAX_STRUCTURED_MEDIA_REF_CHARS)}... (${trimmed.length} chars)`;
  }
  return `[${label}] ${trimmed}`;
}

function summarizeStructuredJsonString(value: string): string {
  const mediaSummary = summarizeStructuredMediaRef("value", value);
  if (mediaSummary?.includes("inline data URI")) {
    return mediaSummary;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_STRUCTURED_JSON_STRING_CHARS) {
    return `${trimmed.slice(0, MAX_STRUCTURED_JSON_STRING_CHARS)}... (${trimmed.length} chars)`;
  }
  return value;
}

function sanitizeStructuredJsonValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") {
    return summarizeStructuredJsonString(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  if (depth >= MAX_STRUCTURED_JSON_DEPTH) {
    return "[max depth]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const limited = value
      .slice(0, MAX_STRUCTURED_JSON_ARRAY_ITEMS)
      .map((item) => sanitizeStructuredJsonValue(item, depth + 1, seen));
    if (value.length > MAX_STRUCTURED_JSON_ARRAY_ITEMS) {
      limited.push(`[${value.length - MAX_STRUCTURED_JSON_ARRAY_ITEMS} more items]`);
    }
    seen.delete(value);
    return limited;
  }
  const output: Record<string, unknown> = {};
  let copied = 0;
  let skipped = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    if (copied >= MAX_STRUCTURED_JSON_OBJECT_KEYS) {
      skipped += 1;
      continue;
    }
    output[key] = sanitizeStructuredJsonValue(
      (value as Record<string, unknown>)[key],
      depth + 1,
      seen,
    );
    copied += 1;
  }
  if (skipped > 0) {
    output.__truncated = `${skipped} more keys`;
  }
  seen.delete(value);
  return output;
}

function stringifyStructuredJsonFallback(part: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(sanitizeStructuredJsonValue(part));
    if (!serialized || serialized === "{}") {
      return undefined;
    }
    const withoutInlineData = serialized.replace(
      /data:[^"'\\\s]+/gi,
      (match) => `[inline data URI: ${match.length} chars]`,
    );
    return withoutInlineData.length > 1_000
      ? `${withoutInlineData.slice(0, 1_000)}... (${withoutInlineData.length} chars)`
      : withoutInlineData;
  } catch {
    return undefined;
  }
}

function stringifyStructuredContentPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }
  const record = part as Record<string, unknown>;
  if (record.type === "text") {
    const text = typeof record.text === "string" ? record.text.trim() : "";
    return text || undefined;
  }
  if (record.type === "image_url") {
    const imageUrl = record.image_url;
    const url =
      typeof imageUrl === "string"
        ? imageUrl
        : imageUrl && typeof imageUrl === "object"
          ? (imageUrl as { url?: unknown }).url
          : undefined;
    return summarizeStructuredMediaRef("image_url", url);
  }
  if (record.type === "image" || record.type === "input_image") {
    return (
      summarizeStructuredMediaRef(record.type, record.url) ??
      summarizeStructuredMediaRef(record.type, record.source)
    );
  }
  if (typeof record.type === "string") {
    const typedRef =
      summarizeStructuredMediaRef(record.type, record.audio_url) ??
      summarizeStructuredMediaRef(record.type, record.media_url) ??
      summarizeStructuredMediaRef(record.type, record.url) ??
      summarizeStructuredMediaRef(record.type, record.source);
    if (typedRef) {
      return typedRef;
    }
  }
  return stringifyStructuredJsonFallback(part);
}

function extractUserMessagePromptText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((part) => {
      const text = stringifyStructuredContentPart(part);
      return text ? [text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function promptAlreadyIncludesQueuedUserMessage(prompt: string, orphanText: string): boolean {
  const normalizedPrompt = prompt.replace(/\r\n/g, "\n");
  const normalizedOrphanText = orphanText.replace(/\r\n/g, "\n").trim();
  if (!normalizedOrphanText) {
    return false;
  }
  const queuedBlockPrefix = `${QUEUED_USER_MESSAGE_MARKER}\n${normalizedOrphanText}`;
  return (
    normalizedPrompt === queuedBlockPrefix ||
    normalizedPrompt.startsWith(`${queuedBlockPrefix}\n`) ||
    normalizedPrompt.includes(`\n${queuedBlockPrefix}\n`) ||
    `\n${normalizedPrompt}\n`.includes(`\n${normalizedOrphanText}\n`)
  );
}

export function mergeOrphanedTrailingUserPrompt(params: {
  prompt: string;
  trigger: EmbeddedRunAttemptParams["trigger"];
  leafMessage: { content?: unknown };
}): { prompt: string; merged: boolean; removeLeaf: boolean } {
  const orphanText = extractUserMessagePromptText(params.leafMessage.content);
  if (!orphanText) {
    return { prompt: params.prompt, merged: false, removeLeaf: true };
  }
  if (promptAlreadyIncludesQueuedUserMessage(params.prompt, orphanText)) {
    return { prompt: params.prompt, merged: false, removeLeaf: true };
  }

  return {
    prompt: [QUEUED_USER_MESSAGE_MARKER, orphanText, "", params.prompt].join("\n"),
    merged: true,
    removeLeaf: true,
  };
}

export function resolveAttemptFsWorkspaceOnly(params: {
  config?: OpenClawConfig;
  sessionAgentId: string;
}): boolean {
  return resolveEffectiveToolFsWorkspaceOnly({
    cfg: params.config,
    agentId: params.sessionAgentId,
  });
}

export function prependSystemPromptAddition(params: {
  systemPrompt: string;
  systemPromptAddition?: string;
}): string {
  return prependSystemPromptAdditionAfterCacheBoundary(params);
}

export function resolveAttemptPrependSystemContext(params: {
  sessionKey?: string;
  trigger?: EmbeddedRunAttemptParams["trigger"];
  hookPrependSystemContext?: string;
}): string | undefined {
  const activeMediaTaskPromptContexts =
    params.trigger === "user" || params.trigger === "manual"
      ? [
          buildActiveImageGenerationTaskPromptContextForSession(params.sessionKey),
          buildActiveVideoGenerationTaskPromptContextForSession(params.sessionKey),
          buildActiveMusicGenerationTaskPromptContextForSession(params.sessionKey),
        ]
      : [];
  return joinPresentTextSegments([
    ...activeMediaTaskPromptContexts,
    params.hookPrependSystemContext,
  ]);
}

type AfterTurnRuntimeContextAttempt = Pick<
  EmbeddedRunAttemptParams,
  | "sessionKey"
  | "sandboxSessionKey"
  | "messageChannel"
  | "messageProvider"
  | "agentAccountId"
  | "currentChannelId"
  | "currentThreadTs"
  | "currentMessageId"
  | "config"
  | "skillsSnapshot"
  | "senderIsOwner"
  | "senderId"
  | "provider"
  | "modelId"
  | "thinkLevel"
  | "reasoningLevel"
  | "bashElevated"
  | "extraSystemPrompt"
  | "ownerNumbers"
  | "authProfileId"
> & {
  sessionId?: EmbeddedRunAttemptParams["sessionId"];
};

/** Build runtime context passed into context-engine afterTurn hooks. */
export function buildAfterTurnRuntimeContext(params: {
  attempt: AfterTurnRuntimeContextAttempt;
  workspaceDir: string;
  agentDir: string;
  activeAgentId?: string;
  contextEnginePluginId?: string;
  tokenBudget?: number;
  currentTokenCount?: number;
  promptCache?: ContextEnginePromptCacheInfo;
}): ContextEngineRuntimeContext {
  return {
    ...buildEmbeddedCompactionRuntimeContext({
      sessionKey: params.attempt.sessionKey,
      messageChannel: params.attempt.messageChannel,
      messageProvider: params.attempt.messageProvider,
      agentAccountId: params.attempt.agentAccountId,
      currentChannelId: params.attempt.currentChannelId,
      currentThreadTs: params.attempt.currentThreadTs,
      currentMessageId: params.attempt.currentMessageId,
      authProfileId: params.attempt.authProfileId,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.attempt.config,
      skillsSnapshot: params.attempt.skillsSnapshot,
      senderIsOwner: params.attempt.senderIsOwner,
      senderId: params.attempt.senderId,
      provider: params.attempt.provider,
      modelId: params.attempt.modelId,
      thinkLevel: params.attempt.thinkLevel,
      reasoningLevel: params.attempt.reasoningLevel,
      bashElevated: params.attempt.bashElevated,
      extraSystemPrompt: params.attempt.extraSystemPrompt,
      ownerNumbers: params.attempt.ownerNumbers,
      activeProcessSessions: listActiveProcessSessionReferences({
        scopeKey: resolveProcessToolScopeKey({
          sessionKey: params.attempt.sandboxSessionKey?.trim() || params.attempt.sessionKey,
          sessionId: params.attempt.sessionId,
          agentId: params.activeAgentId,
        }),
      }),
    }),
    ...resolveContextEngineCapabilities({
      config: params.attempt.config,
      sessionKey: params.attempt.sessionKey,
      agentId: params.activeAgentId,
      contextEnginePluginId: params.contextEnginePluginId,
      purpose: "context-engine.after-turn",
    }),
    ...(typeof params.tokenBudget === "number" &&
    Number.isFinite(params.tokenBudget) &&
    params.tokenBudget > 0
      ? { tokenBudget: Math.floor(params.tokenBudget) }
      : {}),
    ...(typeof params.currentTokenCount === "number" &&
    Number.isFinite(params.currentTokenCount) &&
    params.currentTokenCount > 0
      ? { currentTokenCount: Math.floor(params.currentTokenCount) }
      : {}),
    ...(params.promptCache ? { promptCache: params.promptCache } : {}),
  };
}

export function buildAfterTurnRuntimeContextFromUsage(
  params: Omit<Parameters<typeof buildAfterTurnRuntimeContext>[0], "currentTokenCount"> & {
    lastCallUsage?: NormalizedUsage;
  },
): ContextEngineRuntimeContext {
  return buildAfterTurnRuntimeContext({
    ...params,
    currentTokenCount: derivePromptTokens(params.lastCallUsage),
  });
}
