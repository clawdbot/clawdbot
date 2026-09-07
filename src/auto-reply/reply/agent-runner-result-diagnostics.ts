import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveModelFallbackAvailability } from "../../agents/agent-scope.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { buildInlinePluginStatusPayload } from "./agent-runner-core.js";
import {
  accumulateSessionUsageFromTranscript,
  buildInlineRawTracePayload,
  derivePromptSegments,
  type TraceContextManagementView,
} from "./agent-runner-trace.js";
import type { FollowupRun } from "./queue.js";

/** Builds the same authorized diagnostic supplement for immediate and queued replies. */
export async function buildReplyDiagnosticsPayload(params: {
  activeSessionEntry: SessionEntry | undefined;
  followupRun: Pick<FollowupRun, "run">;
  accounting: {
    runResult: EmbeddedAgentRunResult;
    providerUsed: string;
    modelUsed: string;
    contextTokensUsed: number;
    promptTokens?: number;
  };
  cfg?: OpenClawConfig;
  storePath?: string;
  userText?: string;
  resolvedVerboseLevel?: VerboseLevel;
  resolvedBlockStreamingBreak?: string;
  preflightCompactionApplied?: boolean;
}): Promise<ReplyPayload | undefined> {
  const {
    activeSessionEntry,
    followupRun,
    accounting,
    cfg,
    storePath,
    userText,
    resolvedVerboseLevel,
    resolvedBlockStreamingBreak,
    preflightCompactionApplied,
  } = params;
  const { runResult, providerUsed, modelUsed, contextTokensUsed, promptTokens } = accounting;
  // Inherited preferences can change during execution; explicit turn choices
  // still win over the generation-fenced session supplied by completion.
  const verboseEnabled =
    (normalizeVerboseLevel(
      followupRun.run.verboseLevelOverride ??
        activeSessionEntry?.verboseLevel ??
        resolvedVerboseLevel ??
        followupRun.run.verboseLevel,
    ) ?? "off") !== "off";
  const traceAuthorized = followupRun.run.traceAuthorized === true;
  const traceLevel = followupRun.run.traceLevelOverride ?? activeSessionEntry?.traceLevel;
  const traceEnabled = traceAuthorized && (traceLevel === "on" || traceLevel === "raw");
  if (!verboseEnabled && !traceEnabled) {
    return undefined;
  }
  let diagnosticsPayload = buildInlinePluginStatusPayload({
    entry: activeSessionEntry,
    includeStatusLines: verboseEnabled,
    includeTraceLines: traceEnabled,
  });
  if (traceAuthorized && traceLevel === "raw") {
    const isHookBlockedRun = runResult.meta?.error?.kind === "hook_block";
    const rawUserText = isHookBlockedRun
      ? runResult.meta?.finalPromptText
      : (runResult.meta?.finalPromptText ?? userText);
    const rawAssistantText = isHookBlockedRun
      ? undefined
      : (runResult.meta?.finalAssistantRawText ?? runResult.meta?.finalAssistantVisibleText);
    const executionTrace = runResult.meta?.executionTrace;
    const requestShaping = {
      authMode:
        runResult.meta?.requestShaping?.authMode ??
        (cfg?.models?.providers && providerUsed in cfg.models.providers
          ? (resolveModelAuthMode(providerUsed, cfg, undefined, {
              workspaceDir: followupRun.run.workspaceDir,
            }) ?? undefined)
          : undefined),
      thinking:
        runResult.meta?.requestShaping?.thinking ??
        normalizeOptionalString(followupRun.run.thinkLevel),
      reasoning:
        runResult.meta?.requestShaping?.reasoning ??
        normalizeOptionalString(followupRun.run.reasoningLevel),
      verbose:
        runResult.meta?.requestShaping?.verbose ?? normalizeOptionalString(resolvedVerboseLevel),
      trace:
        followupRun.run.traceLevelOverride ??
        runResult.meta?.requestShaping?.trace ??
        normalizeOptionalString(activeSessionEntry?.traceLevel),
      fallbackEligible:
        runResult.meta?.requestShaping?.fallbackEligible ??
        resolveModelFallbackAvailability({
          cfg: cfg ?? {},
          agentId: followupRun.run.agentId,
          sessionKey: followupRun.run.sessionKey,
          hasSessionModelOverride: followupRun.run.hasSessionModelOverride === true,
          modelOverrideSource: followupRun.run.modelOverrideSource,
          hasAutoFallbackProvenance: followupRun.run.hasAutoFallbackProvenance === true,
          modelSelectionLocked: followupRun.run.modelSelectionLocked,
        }).kind === "active",
      blockStreaming:
        runResult.meta?.requestShaping?.blockStreaming ??
        normalizeOptionalString(resolvedBlockStreamingBreak),
    };
    const promptSegments = runResult.meta?.promptSegments ?? derivePromptSegments(rawUserText);
    const toolSummary = runResult.meta?.toolSummary;
    const completion =
      runResult.meta?.completion ??
      (runResult.meta?.stopReason
        ? {
            stopReason: runResult.meta.stopReason,
            finishReason: runResult.meta.stopReason,
            ...(runResult.meta.stopReason.toLowerCase().includes("refusal")
              ? { refusal: true }
              : {}),
          }
        : undefined);
    const contextManagement = {
      ...(typeof activeSessionEntry?.compactionCount === "number"
        ? { sessionCompactions: activeSessionEntry.compactionCount }
        : {}),
      ...(typeof runResult.meta?.contextManagement?.lastTurnCompactions === "number"
        ? { lastTurnCompactions: runResult.meta.contextManagement.lastTurnCompactions }
        : typeof runResult.meta?.agentMeta?.compactionCount === "number"
          ? { lastTurnCompactions: runResult.meta.agentMeta.compactionCount }
          : {}),
      ...(runResult.meta?.contextManagement &&
      typeof runResult.meta.contextManagement.preflightCompactionApplied === "boolean"
        ? {
            preflightCompactionApplied: runResult.meta.contextManagement.preflightCompactionApplied,
          }
        : preflightCompactionApplied
          ? { preflightCompactionApplied }
          : {}),
      ...(runResult.meta?.contextManagement &&
      typeof runResult.meta.contextManagement.postCompactionContextInjected === "boolean"
        ? {
            postCompactionContextInjected:
              runResult.meta.contextManagement.postCompactionContextInjected,
          }
        : {}),
    } satisfies TraceContextManagementView;
    const sessionUsage = await accumulateSessionUsageFromTranscript({
      agentId: followupRun.run.agentId,
      sessionId: runResult.meta?.agentMeta?.sessionId ?? followupRun.run.sessionId,
      sessionKey: followupRun.run.sessionKey,
      storePath,
      sessionFile: followupRun.run.sessionFile,
    });
    const rawTracePayload = buildInlineRawTracePayload({
      rawUserText,
      rawAssistantText,
      sessionUsage,
      usage: runResult.meta?.agentMeta?.usage,
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      provider: providerUsed,
      model: modelUsed,
      contextLimit: contextTokensUsed,
      promptTokens,
      executionTrace,
      requestShaping,
      promptSegments,
      toolSummary,
      completion,
      contextManagement,
    });
    diagnosticsPayload = diagnosticsPayload
      ? { text: `${diagnosticsPayload.text}\n\n${rawTracePayload.text}` }
      : rawTracePayload;
  }
  return diagnosticsPayload ? { ...diagnosticsPayload, isStatusNotice: true } : undefined;
}
