// Context-engine delegates bridge custom engines to built-in compaction and memory prompt paths.
import path from "node:path";
import { normalizeStructuredPromptSection } from "@openclaw/ai/internal/shared";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { listSessionEntriesCore, loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  buildMemoryPromptSection,
  getActivePreparedMemoryPromptSection,
  prepareMemoryPromptSection,
  type MemoryPromptSectionParams,
  type PreparedMemoryPromptSection,
} from "../plugins/memory-state.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type {
  ContextEngine,
  CompactResult,
  ContextEngineRuntimeContext,
  ContextEngineSessionTarget,
} from "./types.js";

const loadCompactRuntime = createLazyRuntimeModule(
  () => import("../agents/embedded-agent-runner/compact.runtime.js"),
);

function buildCompactionResultSessionTarget(params: {
  agentId?: string;
  callerSessionId?: string;
  callerSessionTarget?: ContextEngineSessionTarget;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
}): ContextEngineSessionTarget | undefined {
  const sessionFile = normalizeOptionalString(params.sessionFile);
  const marker = parseSqliteSessionFileMarker(sessionFile);
  const targetAgentId = normalizeOptionalString(params.callerSessionTarget?.agentId);
  const targetSessionId = normalizeOptionalString(params.callerSessionTarget?.sessionId);
  const targetSessionKey = normalizeOptionalString(params.callerSessionTarget?.sessionKey);
  const targetStorePath = normalizeOptionalString(params.callerSessionTarget?.storePath);
  const requestedAgentId = normalizeOptionalString(params.agentId);
  const callerSessionId = normalizeOptionalString(params.callerSessionId);
  const requestedSessionKey = normalizeOptionalString(params.sessionKey);
  const requestedSessionKeyAgentId = parseAgentSessionKey(requestedSessionKey)?.agentId;
  if (
    (requestedAgentId && targetAgentId && requestedAgentId !== targetAgentId) ||
    (callerSessionId && targetSessionId && callerSessionId !== targetSessionId) ||
    (requestedSessionKey && targetSessionKey && requestedSessionKey !== targetSessionKey) ||
    (requestedSessionKeyAgentId && targetAgentId && requestedSessionKeyAgentId !== targetAgentId)
  ) {
    throw new Error("Context-engine successor target conflicts with the caller session identity");
  }
  const suppliedAgentId = targetAgentId ?? requestedAgentId;
  const suppliedSessionId = normalizeOptionalString(params.sessionId);
  const suppliedSessionKey = targetSessionKey ?? requestedSessionKey;
  const suppliedSessionKeyAgentId = parseAgentSessionKey(suppliedSessionKey)?.agentId;
  const callerAgentId = suppliedAgentId ?? suppliedSessionKeyAgentId;
  if (
    (callerAgentId && marker && marker.agentId !== callerAgentId) ||
    (targetStorePath && marker && path.resolve(marker.storePath) !== path.resolve(targetStorePath))
  ) {
    throw new Error("Context-engine successor target conflicts with the caller session identity");
  }
  if (marker && suppliedSessionId && marker.sessionId !== suppliedSessionId) {
    throw new Error("Context-engine successor identity is inconsistent");
  }
  const candidateEntry =
    marker && suppliedSessionKey
      ? loadSessionEntry({
          agentId: marker.agentId,
          sessionKey: suppliedSessionKey,
          storePath: marker.storePath,
        })
      : undefined;
  const markerMatches = marker
    ? listSessionEntriesCore({
        agentId: marker.agentId,
        storePath: marker.storePath,
      }).filter(({ entry }) => entry.sessionId === marker.sessionId)
    : [];
  const preferredMarkerSessionKey = marker
    ? resolvePreferredSessionKeyForSessionIdMatches(
        markerMatches.map(({ sessionKey, entry }) => [sessionKey, entry]),
        marker.sessionId,
      )
    : undefined;
  const callerAuthorizedMarkerKey = Boolean(
    suppliedSessionKey && (!candidateEntry || candidateEntry.sessionId === callerSessionId),
  );
  const markerSessionKey = marker
    ? callerAuthorizedMarkerKey || candidateEntry?.sessionId === marker.sessionId
      ? suppliedSessionKey
      : (preferredMarkerSessionKey ?? (candidateEntry ? undefined : suppliedSessionKey))
    : undefined;
  if (sessionFile && !marker) {
    throw new Error("Legacy context-engine file successors are unsupported");
  }
  if (marker && !markerSessionKey) {
    throw new Error("Legacy context-engine successor identity is ambiguous");
  }
  if (
    marker &&
    suppliedSessionKey &&
    ((candidateEntry &&
      candidateEntry.sessionId !== marker.sessionId &&
      !callerAuthorizedMarkerKey) ||
      (!candidateEntry && markerMatches.length > 0))
  ) {
    throw new Error("Legacy context-engine successor session key is inconsistent");
  }
  if (marker && suppliedSessionKeyAgentId && suppliedSessionKeyAgentId !== marker.agentId) {
    throw new Error("Legacy context-engine successor identity is inconsistent");
  }
  const sessionId = marker?.sessionId ?? suppliedSessionId ?? targetSessionId ?? callerSessionId;
  if (!sessionId) {
    return undefined;
  }
  const agentId = marker?.agentId ?? callerAgentId;
  const sessionKey = marker ? markerSessionKey : suppliedSessionKey;
  const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (sessionKeyAgentId && agentId && sessionKeyAgentId !== agentId) {
    throw new Error("Context-engine successor session key conflicts with its agent identity");
  }
  const storePath = marker?.storePath ?? targetStorePath;
  return {
    ...(agentId ? { agentId } : {}),
    sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(storePath ? { storePath } : {}),
    ...(params.callerSessionTarget?.threadId !== undefined
      ? { threadId: params.callerSessionTarget.threadId }
      : {}),
  };
}

/**
 * Delegate a context-engine compaction request to OpenClaw's built-in runtime compaction path.
 *
 * This is the same bridge used by the legacy context engine. Third-party
 * engines can call it from their own `compact()` implementations when they do
 * not own the compaction algorithm but still need `/compact` and overflow
 * recovery to use the stock runtime behavior.
 *
 * Note: `compactionTarget` is part of the public `compact()` contract, but the
 * built-in runtime compaction path does not expose that knob. This helper
 * ignores it to preserve legacy behavior; engines that need target-specific
 * compaction should implement their own `compact()` algorithm.
 */
export async function delegateCompactionToRuntime(
  params: Parameters<ContextEngine["compact"]>[0],
): Promise<CompactResult> {
  // Load through the dedicated runtime boundary without introducing another
  // source-level static edge into the embedded runner graph.
  const { compactEmbeddedAgentSessionOnDemand } = await loadCompactRuntime();
  type RuntimeCompactionParams = Parameters<typeof compactEmbeddedAgentSessionOnDemand>[0];

  // runtimeContext carries host-resolved runtime fields set by internal
  // callers. Keep the public delegate keyed by session identity, not by the
  // active transcript artifact that the runtime may resolve internally.
  const runtimeContext = (params.runtimeContext ?? {}) as ContextEngineRuntimeContext &
    Partial<RuntimeCompactionParams>;
  const { sessionFile: _legacySessionFile, ...runtimeContextParams } = runtimeContext;
  const sessionTarget = params.sessionTarget ?? runtimeContext.sessionTarget;
  const agentId = params.agentId ?? runtimeContext.agentId;
  const sessionKey = params.sessionKey ?? runtimeContext.sessionKey;
  const currentTokenCount =
    params.currentTokenCount ??
    (typeof runtimeContext.currentTokenCount === "number" &&
    Number.isFinite(runtimeContext.currentTokenCount) &&
    runtimeContext.currentTokenCount > 0
      ? Math.floor(runtimeContext.currentTokenCount)
      : undefined);

  const result = await compactEmbeddedAgentSessionOnDemand({
    ...runtimeContextParams,
    ...(agentId ? { agentId } : {}),
    sessionId: params.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionTarget ? { sessionTarget } : {}),
    tokenBudget: params.tokenBudget,
    ...(currentTokenCount !== undefined ? { currentTokenCount } : {}),
    force: params.force,
    customInstructions: params.customInstructions,
    abortSignal: params.abortSignal,
    workspaceDir:
      typeof runtimeContext.workspaceDir === "string" ? runtimeContext.workspaceDir : process.cwd(),
  });
  const resultSessionTarget = result.result
    ? buildCompactionResultSessionTarget({
        agentId,
        callerSessionId: params.sessionId,
        callerSessionTarget: sessionTarget,
        sessionFile: result.result.sessionFile,
        sessionId: result.result.sessionId,
        sessionKey,
      })
    : undefined;

  return {
    ok: result.ok,
    compacted: result.compacted,
    reason: result.reason,
    result: result.result
      ? {
          summary: result.result.summary,
          firstKeptEntryId: result.result.firstKeptEntryId,
          tokensBefore: result.result.tokensBefore,
          tokensAfter: result.result.tokensAfter,
          details: result.result.details,
          ...(result.result.sessionId
            ? { sessionId: resultSessionTarget?.sessionId ?? result.result.sessionId }
            : {}),
          // Core reports successors only through the typed sessionTarget; the
          // deprecated raw sessionFile field is reserved for shipped engines
          // reporting rotation to core, and post-flip core has no file path.
          ...(resultSessionTarget ? { sessionTarget: resultSessionTarget } : {}),
        }
      : undefined,
  };
}

/**
 * Build a context-engine-ready systemPromptAddition from the active memory
 * plugin prompt path. This lets non-legacy engines explicitly opt into the
 * same memory/wiki guidance that the legacy engine gets via system prompt
 * assembly, without reimplementing memory prompt formatting.
 */
function renderMemorySystemPromptAddition(
  params: MemoryPromptSectionParams,
  prepared?: PreparedMemoryPromptSection,
): string | undefined {
  const lines = buildMemoryPromptSection(params, prepared);
  if (lines.length === 0) {
    return undefined;
  }
  const normalized = normalizeStructuredPromptSection(lines.join("\n"));
  return normalized || undefined;
}

export function buildMemorySystemPromptAddition(
  params: MemoryPromptSectionParams,
): string | undefined {
  const prepared = getActivePreparedMemoryPromptSection();
  if (!prepared) {
    return renderMemorySystemPromptAddition(params);
  }
  const contextParams: MemoryPromptSectionParams = {
    availableTools: params.availableTools,
    citationsMode: params.citationsMode ?? prepared.context.citationsMode,
    agentId: params.agentId ?? prepared.context.agentId,
    agentSessionKey: params.agentSessionKey ?? prepared.context.agentSessionKey,
    sandboxed: params.sandboxed ?? prepared.context.sandboxed,
    // A prepared cut-over section is the run-owned proof that its legacy
    // supplements were withheld. Keep that state when the delegate rebuilds
    // its synchronous view, or an omitted flag would reopen those supplements.
    memoryReadEnforced:
      params.memoryReadEnforced ?? (prepared.context.memoryReadEnforced ? true : undefined),
    authorizedMemoryRead: params.authorizedMemoryRead ?? prepared.context.authorizedMemoryRead,
  };
  return renderMemorySystemPromptAddition(contextParams, prepared);
}

/** Prepare memory state asynchronously, then render it without prompt-path I/O. */
export async function prepareMemorySystemPromptAddition(
  params: MemoryPromptSectionParams,
): Promise<string | undefined> {
  const prepared = await prepareMemoryPromptSection(params);
  return renderMemorySystemPromptAddition(params, prepared);
}
