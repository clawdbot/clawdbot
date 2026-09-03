import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemoryReadResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  attemptMemoryCorpus,
  composeMemoryCorpusMetadata,
  readMemoryCorpusSupplements,
  runMemoryCorpusDeadline,
  type MemoryCorpusAttempt,
} from "./memory-corpus.js";

type MemoryReadRequest = {
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  signal?: AbortSignal;
};

function readWiki(params: MemoryReadRequest, signal: AbortSignal) {
  return readMemoryCorpusSupplements({
    lookup: params.relPath,
    fromLine: params.from,
    lineCount: params.lines,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
    signal,
  });
}

function attemptValue<T>(attempt: MemoryCorpusAttempt<T>): T | null {
  return attempt.outcome === "not-registered" ? null : attempt.value;
}

export async function executeWikiMemoryReadResult(params: MemoryReadRequest) {
  return await runMemoryCorpusDeadline({
    operation: "memory_get",
    parentSignal: params.signal,
    run: async (signal) => {
      const wiki = await readWiki(params, signal);
      const result =
        attemptValue(wiki) ??
        (wiki.outcome === "ok"
          ? { status: "not_found" as const, path: params.relPath, text: "" as const }
          : { path: params.relPath, text: "" });
      return jsonResult({ ...result, ...composeMemoryCorpusMetadata([wiki]) });
    },
  });
}

export async function executeMemoryReadResult(
  params: MemoryReadRequest & { read: () => Promise<MemoryReadResult> },
) {
  if (params.requestedCorpus !== "all") {
    try {
      return jsonResult(await params.read());
    } catch (error) {
      return jsonResult({
        path: params.relPath,
        text: "",
        disabled: true,
        error: formatErrorMessage(error),
      });
    }
  }
  return await runMemoryCorpusDeadline({
    operation: "memory_get",
    parentSignal: params.signal,
    run: async (signal) => {
      const [memory, wiki] = await Promise.all([
        attemptMemoryCorpus({
          corpus: "memory",
          signal,
          unavailableValue: null,
          run: params.read,
        }),
        readWiki(params, signal),
      ]);
      const memoryResult = attemptValue(memory);
      const wikiResult = attemptValue(wiki);
      const result =
        memoryResult?.status !== "not_found" && memoryResult !== null
          ? memoryResult
          : (wikiResult ??
            (memory.outcome === "ok" || wiki.outcome === "ok"
              ? { status: "not_found" as const, path: params.relPath, text: "" as const }
              : { path: params.relPath, text: "", disabled: true }));
      return jsonResult({ ...result, ...composeMemoryCorpusMetadata([memory, wiki]) });
    },
  });
}
