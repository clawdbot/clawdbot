// Context-engine delegates bridge custom engines to built-in compaction and memory prompt paths.
import { normalizeStructuredPromptSection } from "@openclaw/ai/internal/shared";
import {
  buildMemoryPromptSection,
  getActivePreparedMemoryPromptSection,
  prepareMemoryPromptSection,
  type MemoryPromptSectionParams,
  type PreparedMemoryPromptSection,
} from "../plugins/memory-state.js";
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
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
}): ContextEngineSessionTarget | undefined {
  const sessionId = params.sessionTarget?.sessionId ?? params.sessionId;
  if (!sessionId) {
    return undefined;
  }
  const agentId = params.sessionTarget?.agentId ?? params.agentId;
  const sessionKey = params.sessionTarget?.sessionKey ?? params.sessionKey;
  const storePath = params.sessionTarget?.storePath;
  return {
    ...(agentId ? { agentId } : {}),
    sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(storePath ? { storePath } : {}),
    ...(params.sessionTarget?.threadId !== undefined
      ? { threadId: params.sessionTarget.threadId }
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
  const { compactEmbeddedAgentSessionDirect } = await loadCompactRuntime();
  type RuntimeCompactionParams = Parameters<typeof compactEmbeddedAgentSessionDirect>[0];

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

  const result = await compactEmbeddedAgentSessionDirect({
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
        sessionFile: result.result.sessionFile,
        sessionId: result.result.sessionId,
        sessionKey,
        sessionTarget,
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
          ...(result.result.sessionId ? { sessionId: result.result.sessionId } : {}),
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
  const lines = buildMemoryPromptSection(
    {
      availableTools: params.availableTools,
      citationsMode: params.citationsMode,
      agentId: params.agentId,
      agentSessionKey: params.agentSessionKey,
      sandboxed: params.sandboxed,
    },
    prepared,
  );
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
  };
  return renderMemorySystemPromptAddition(contextParams, prepared);
}

/** Prepare memory state asynchronously, then render it without prompt-path I/O. */
export async function prepareMemorySystemPromptAddition(
  params: MemoryPromptSectionParams,
): Promise<string | undefined> {
  const prepared = await prepareMemoryPromptSection({
    availableTools: params.availableTools,
    citationsMode: params.citationsMode,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
  });
  return renderMemorySystemPromptAddition(params, prepared);
}
