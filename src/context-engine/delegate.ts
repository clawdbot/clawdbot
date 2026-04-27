import type { CompactEmbeddedPiSessionDirect } from "../agents/pi-embedded-runner/compact.runtime.types.js";
import { normalizeStructuredPromptSection } from "../agents/prompt-cache-stability.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import { buildMemoryPromptSection } from "../plugins/memory-state.js";
import type { ContextEngine, CompactResult, ContextEngineRuntimeContext } from "./types.js";

type CompactRuntimeModule = {
  compactEmbeddedPiSessionDirect: CompactEmbeddedPiSessionDirect;
};

let compactRuntimePromise: Promise<CompactRuntimeModule> | null = null;

function loadCompactRuntime(): Promise<CompactRuntimeModule> {
  // Use a literal specifier so the bundler rewrites the runtime chunk path
  // instead of resolving a source-tree path at runtime.
  compactRuntimePromise ??= import("../agents/pi-embedded-runner/compact.runtime.js");
  return compactRuntimePromise;
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
  const { compactEmbeddedPiSessionDirect } = await loadCompactRuntime();
  type RuntimeCompactionParams = Parameters<typeof compactEmbeddedPiSessionDirect>[0];

  // runtimeContext carries the full CompactEmbeddedPiSessionParams fields set
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

  const result = await compactEmbeddedPiSessionDirect({
    ...runtimeContext,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    tokenBudget: params.tokenBudget,
    ...(currentTokenCount !== undefined ? { currentTokenCount } : {}),
    force: params.force,
    customInstructions: params.customInstructions,
    workspaceDir:
      typeof runtimeContext.workspaceDir === "string" ? runtimeContext.workspaceDir : process.cwd(),
  });

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
          sessionFile: result.result.sessionFile,
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
}): string | undefined {
  const lines = buildMemoryPromptSection({
    availableTools: params.availableTools,
    citationsMode: params.citationsMode,
  });
  if (lines.length === 0) {
    return undefined;
  }
  const normalized = normalizeStructuredPromptSection(lines.join("\n"));
  return normalized || undefined;
}
