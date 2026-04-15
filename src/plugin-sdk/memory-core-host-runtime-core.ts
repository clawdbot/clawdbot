import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultAgentId, resolveSessionAgentId } from "../agents/agent-scope.js";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";

export type { OpenClawConfig, ResolvedMemorySearchConfig };
export type { AnyAgentTool } from "../agents/tools/common.js";
export type { MemoryCitationsMode } from "../config/types.memory.js";
export type { ParsedAgentSessionKey } from "../sessions/session-key-utils.js";

export { resolveDefaultAgentId, resolveSessionAgentId } from "../agents/agent-scope.js";
export { resolveMemorySearchConfig } from "../agents/memory-search.js";
export { jsonResult, readNumberParam, readStringParam } from "../agents/tools/common.js";
export { resolveCronStyleNow } from "../agents/current-time.js";
export { DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR } from "../agents/pi-settings.js";
export { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
export { parseNonNegativeByteSize } from "../config/byte-size.js";
export { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
export { resolveStateDir } from "../config/paths.js";
export { parseAgentSessionKey } from "../sessions/session-key-utils.js";

export type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
};

export type MemoryCorpusSearchResult = {
  source: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  citation?: string;
};

export type MemoryCorpusGetResult = {
  source: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
};

export type MemoryCorpusSupplementRegistration = {
  id: string;
  supplement: {
    search: (params: {
      query: string;
      maxResults?: number;
      agentSessionKey?: string;
      corpus?: "memory" | "wiki" | "all";
    }) => Promise<MemoryCorpusSearchResult[]>;
    get: (params: {
      lookup: string;
      fromLine?: number;
      lineCount?: number;
      agentSessionKey?: string;
      corpus?: "memory" | "wiki" | "all";
    }) => Promise<MemoryCorpusGetResult | null>;
  };
};

const MEMORY_CORPUS_SUPPLEMENTS_KEY = Symbol.for("openclaw.memoryCore.corpusSupplements");

function resolveSupplementStore(): MemoryCorpusSupplementRegistration[] {
  const root = globalThis as typeof globalThis & {
    [MEMORY_CORPUS_SUPPLEMENTS_KEY]?: MemoryCorpusSupplementRegistration[];
  };
  root[MEMORY_CORPUS_SUPPLEMENTS_KEY] ??= [];
  return root[MEMORY_CORPUS_SUPPLEMENTS_KEY];
}

export function registerMemoryCorpusSupplement(
  registration: MemoryCorpusSupplementRegistration,
): void {
  const store = resolveSupplementStore();
  const existing = store.findIndex((entry) => entry.id === registration.id);
  if (existing >= 0) {
    store[existing] = registration;
    return;
  }
  store.push(registration);
}

export function listMemoryCorpusSupplements(): MemoryCorpusSupplementRegistration[] {
  return [...resolveSupplementStore()];
}

export type MemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode: import("../config/types.memory.js").MemoryCitationsMode;
}) => string[];

export type MemoryPluginRuntime = {
  getMemorySearchManager: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status";
  }) => Promise<{ manager: unknown | null; error?: string }>;
  resolveMemoryBackendConfig?: (params: {
    cfg: OpenClawConfig;
    agentId: string;
  }) => unknown;
  closeAllMemorySearchManagers?: () => Promise<void>;
};
