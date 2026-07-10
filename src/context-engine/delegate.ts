// Context-engine delegates bridge custom engines to built-in compaction and memory prompt paths.
import { normalizeStructuredPromptSection } from "@openclaw/ai/internal/shared";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import { buildMemoryPromptSection } from "../plugins/memory-state.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { ContextEngine, CompactResult, ContextEngineRuntimeContext } from "./types.js";

const loadCompactRuntime = createLazyRuntimeModule(
  () => import("../agents/embedded-agent-runner/compact.runtime.js"),
);

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

  // runtimeContext carries the full CompactEmbeddedAgentSessionParams fields set
  // by runtime callers. We spread them and override the fields that come from
  // the public ContextEngine compact() signature directly.
  const runtimeContext = (params.runtimeContext ?? {}) as ContextEngineRuntimeContext &
    Partial<RuntimeCompactionParams>;
  const currentTokenCount =
    params.currentTokenCount ??
    (typeof runtimeContext.currentTokenCount === "number" &&
    Number.isFinite(runtimeContext.currentTokenCount) &&
    runtimeContext.currentTokenCount > 0
      ? Math.floor(runtimeContext.currentTokenCount)
      : undefined);

  const result = await compactEmbeddedAgentSessionDirect({
    ...runtimeContext,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    tokenBudget: params.tokenBudget,
    ...(currentTokenCount !== undefined ? { currentTokenCount } : {}),
    force: params.force,
    customInstructions: params.customInstructions,
    abortSignal: params.abortSignal,
    workspaceDir:
      typeof runtimeContext.workspaceDir === "string" ? runtimeContext.workspaceDir : process.cwd(),
  });

  // Post-compaction live session: the runtime reports rotation through the
  // result sessionId/sessionFile pair; otherwise the input session stays live.
  const successorSessionId = result.result?.sessionId ?? params.sessionId;
  const successorSessionFile = result.result?.sessionFile ?? params.sessionFile;
  const agentId = runtimeContext.sessionTarget?.agentId ?? runtimeContext.agentId;
  const sessionKey = params.sessionKey ?? runtimeContext.sessionKey;

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
          sessionId: result.result.sessionId,
          // Deprecated raw path stays populated for shipped plugin-sdk readers
          // of the delegate result; sessionTarget is the canonical successor.
          sessionFile: result.result.sessionFile,
          sessionTarget: {
            kind: "file",
            ...(agentId ? { agentId } : {}),
            sessionId: successorSessionId,
            ...(sessionKey ? { sessionKey } : {}),
            sessionFile: successorSessionFile,
          },
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
export function buildMemorySystemPromptAddition(params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): string | undefined {
  const lines = buildMemoryPromptSection({
    availableTools: params.availableTools,
    citationsMode: params.citationsMode,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
  });
  if (lines.length === 0) {
    return undefined;
  }
  const normalized = normalizeStructuredPromptSection(lines.join("\n"));
  return normalized || undefined;
}
