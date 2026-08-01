// Legacy context engine wraps pre-plugin context behavior behind the pluggable interface.
import { delegateCompactionToRuntime } from "./delegate.js";
import { CONTEXT_ENGINE_HOST_PARAMS } from "./registry.js";
import type { AssembleResult, ContextEngine, ContextEngineInfo } from "./types.js";

/**
 * LegacyContextEngine wraps the existing compaction behavior behind the
 * ContextEngine interface, preserving 100% backward compatibility.
 *
 * - ingest: no-op (SessionManager handles message persistence)
 * - assemble: pass-through (existing sanitize/validate/limit pipeline in attempt.ts handles this)
 * - compact: delegates to compactEmbeddedAgentSessionDirect
 */
export class LegacyContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "legacy",
    name: "Legacy Context Engine",
    version: "1.0.0",
    acceptedHostParams: [...CONTEXT_ENGINE_HOST_PARAMS],
  };

  async ingest(_params: Parameters<ContextEngine["ingest"]>[0]) {
    // No-op: SessionManager handles message persistence in the legacy flow
    return { ingested: false };
  }

  async assemble(params: Parameters<ContextEngine["assemble"]>[0]): Promise<AssembleResult> {
    // Pass-through: the existing sanitize -> validate -> limit -> repair pipeline
    // in attempt.ts handles context assembly for the legacy engine.
    // We just return the messages as-is with a rough token estimate.
    return {
      messages: params.messages,
      estimatedTokens: 0, // Caller handles estimation
    };
  }

  async afterTurn(_params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]): Promise<void> {
    // No-op: legacy flow persists context directly in SessionManager.
  }

  compact(params: Parameters<ContextEngine["compact"]>[0]) {
    return delegateCompactionToRuntime(params);
  }

  async dispose(): Promise<void> {
    // Nothing to clean up for legacy engine
  }
}
