import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "./api.js";
import type { MemoryConfig } from "./config.js";
import {
  type Embeddings,
  isMemoryRecallTimeoutError,
  MemoryRecallEmbeddingError,
  runWithTimeout,
} from "./embeddings.js";
import type { MemoryDB } from "./lancedb-store.js";
import { dropMediaNoteLines } from "./memory-capture-sanitization.js";
import {
  cleanMemorySearchResults,
  extractLatestUserText,
  formatRelevantMemoriesContext,
  normalizeRecallQuery,
} from "./memory-policy.js";

const AUTO_RECALL_TIMEOUT_MS = 15_000;
const AUTO_RECALL_OVERFETCH_LIMIT = 10;
const AUTO_RECALL_RESULT_CAP = 3;

type AutoRecallToolAuthority = {
  allows(toolName: string): boolean;
  assertActive(): void;
};

type AutoRecallHookContext = {
  agentId?: string;
  toolAuthority?: AutoRecallToolAuthority;
};

type AutoRecallHookEvent = {
  prompt: string;
  messages: unknown[];
};

export function createAutoRecallHook(params: {
  logger: OpenClawPluginApi["logger"];
  db: MemoryDB;
  embeddings: Embeddings;
  resolveCurrentConfig: () => MemoryConfig;
  resolveEnabledAgentId: (rawAgentId: string | undefined) => string | undefined;
  readCooldown: (agentId: string) => { error: string } | undefined;
  recordCooldown: (agentId: string, error: string) => void;
}) {
  return async (event: AutoRecallHookEvent, ctx: AutoRecallHookContext) => {
    const currentCfg = params.resolveCurrentConfig();
    const recallMaxChars = currentCfg.recallMaxChars;
    if (!currentCfg.autoRecall) {
      return undefined;
    }
    const toolAuthority = ctx.toolAuthority;
    if (!toolAuthority) {
      params.logger.debug?.(
        "memory-lancedb: auto-recall skipped because this prompt has no turn tool authority",
      );
      return undefined;
    }
    toolAuthority.assertActive();
    if (!toolAuthority.allows("memory_recall")) {
      params.logger.debug?.("memory-lancedb: auto-recall skipped by turn tool policy");
      return undefined;
    }
    const agentId = params.resolveEnabledAgentId(ctx.agentId);
    if (!agentId || !event.prompt || event.prompt.length < 5) {
      return undefined;
    }
    // One hung embedding request must not stall both automatic and explicit recall.
    // Keep the breaker per agent so unrelated memory namespaces still probe.
    const cooldown = params.readCooldown(agentId);
    if (cooldown) {
      params.logger.debug?.(
        `memory-lancedb: auto-recall skipped during recall cooldown: ${cooldown.error}`,
      );
      return undefined;
    }

    try {
      const recallQuery = normalizeRecallQuery(
        dropMediaNoteLines(extractLatestUserText(event.messages) ?? event.prompt),
        recallMaxChars,
      );
      if (!recallQuery) {
        return undefined;
      }
      let recallPhase: "embedding" | "search" = "embedding";
      toolAuthority.assertActive();
      const recall = await runWithTimeout({
        timeoutMs: AUTO_RECALL_TIMEOUT_MS,
        task: async (deadlineAtMs) => {
          let vector: number[];
          try {
            vector = await params.embeddings.embed(
              agentId,
              recallQuery,
              currentCfg.embedding,
              Math.max(1, deadlineAtMs - Date.now()),
            );
          } catch (error) {
            throw new MemoryRecallEmbeddingError(error);
          }
          toolAuthority.assertActive();
          // Keep one end-to-end deadline, but only let embedding timeouts trip
          // the shared breaker. LanceDB stalls remain retryable next turn.
          recallPhase = "search";
          return await params.db.search(agentId, vector, AUTO_RECALL_OVERFETCH_LIMIT, 0.3, {
            timeoutMs: Math.max(0, deadlineAtMs - Date.now()),
          });
        },
      });
      toolAuthority.assertActive();
      if (recall.status === "timeout") {
        if (recallPhase === "embedding") {
          params.recordCooldown(
            agentId,
            `auto-recall timed out after ${Math.round(AUTO_RECALL_TIMEOUT_MS / 1000)}s`,
          );
        }
        params.logger.warn?.(
          `memory-lancedb: auto-recall timed out after ${AUTO_RECALL_TIMEOUT_MS}ms; skipping memory injection to avoid stalling agent startup`,
        );
        return undefined;
      }

      const cleanResults = cleanMemorySearchResults(recall.value)
        .map(({ entry }) => entry)
        .slice(0, AUTO_RECALL_RESULT_CAP);
      if (cleanResults.length === 0) {
        return undefined;
      }
      params.logger.info?.(
        `memory-lancedb: injecting ${cleanResults.length} memories into context`,
      );
      const context = formatRelevantMemoriesContext(cleanResults, recallMaxChars);
      return context ? { prependContext: context } : undefined;
    } catch (err) {
      if (
        err instanceof MemoryRecallEmbeddingError &&
        isMemoryRecallTimeoutError(err.originalError)
      ) {
        params.recordCooldown(agentId, formatErrorMessage(err.originalError));
      }
      params.logger.warn(`memory-lancedb: recall failed: ${String(err)}`);
      return undefined;
    }
  };
}
