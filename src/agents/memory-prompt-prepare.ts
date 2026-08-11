import type { MemoryCitationsMode } from "../config/types.memory.js";
import { isMemoryIsolationCutoverAgent } from "../plugins/memory-cutover.js";
import {
  prepareMemoryPromptSection,
  type PreparedMemoryPromptSection,
} from "../plugins/memory-state.js";
import type { AuthorizedMemoryReadHost } from "../plugins/tool-types.js";

/** Prepare memory prompt state with the same normalized tool context used by assembly. */
export async function prepareAgentMemoryPrompt(params: {
  enabled: boolean;
  toolNames: Iterable<string>;
  capabilityToolNames?: Iterable<string>;
  citationsMode?: MemoryCitationsMode;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  /** Host-minted selected-runtime invocation for this exact prompt run. */
  authorizedMemoryRead?: AuthorizedMemoryReadHost;
}): Promise<PreparedMemoryPromptSection | undefined> {
  if (!params.enabled) {
    return undefined;
  }
  const availableTools = new Set(
    [...params.toolNames, ...(params.capabilityToolNames ?? [])]
      .map((tool) => tool.trim().toLowerCase())
      .filter(Boolean),
  );
  return prepareMemoryPromptSection({
    availableTools,
    citationsMode: params.citationsMode,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
    authorizedMemoryRead: params.authorizedMemoryRead,
    ...(params.agentId && isMemoryIsolationCutoverAgent(params.agentId)
      ? { memoryReadEnforced: true as const }
      : {}),
  });
}
