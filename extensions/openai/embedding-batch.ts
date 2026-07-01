// Openai plugin module implements embedding batch behavior.
import {
  applyEmbeddingBatchOutputLine,
  buildBatchHeaders,
  buildEmbeddingBatchGroupOptions,
  EMBEDDING_BATCH_ENDPOINT,
  extractBatchErrorMessage,
  formatUnavailableBatchError,
  normalizeBatchBaseUrl,
  postJsonWithRetry,
  resolveBatchCompletionFromStatus,
  resolveCompletedBatchResult,
  runEmbeddingBatchGroups,
  throwIfBatchTerminalFailure,
  type EmbeddingBatchStatus,
  type BatchCompletionResult,
  type ProviderBatchOutputLine,
  uploadBatchJsonlFile,
  withRemoteHttpResponse,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  readProviderJsonResponse,
  readProviderTextResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenAiEmbeddingClient } from "./embedding-provider.js";

type EmbeddingBatchExecutionParams = {
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
};

type OpenAiBatchRequest = {
  custom_id: string;
  method: "POST";
  url: "/v1/embeddings";
  body: {
    model: string;
    input: string;
  };
};

type OpenAiBatchStatus = EmbeddingBatchStatus & {
  request_counts?: {
    total?: number;
    completed?: number;
    failed?: number;
  };
};
type OpenAiBatchOutputLine = ProviderBatchOutputLine;

export const OPENAI_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const OPENAI_BATCH_COMPLETION_WINDOW = "24h";
const OPENAI_BATCH_MAX_REQUESTS = 50000;
// OpenAI accepts 200 MB Batch input files. Keep a safety margin so the JSONL
// splitter avoids boundary-size uploads while preserving source-wide batching.
const OPENAI_BATCH_MAX_JSONL_BYTES = 190 * 1024 * 1024;
const OPENAI_BATCH_MAX_POLL_BACKOFF_MS = 5 * 60_000;
const OPENAI_BATCH_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const OPENAI_BATCH_OUTPUT_LINE_MAX_BYTES = 4 * 1024 * 1024;

async function submitOpenAiBatch(params: {
  openAi: OpenAiEmbeddingClient;
  requests: OpenAiBatchRequest[];
  agentId: string;
}): Promise<OpenAiBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.openAi);
  const inputFileId = await uploadBatchJsonlFile({
    client: params.openAi,
    requests: params.requests,
    errorPrefix: "openai batch file upload failed",
  });

  return await postJsonWithRetry<OpenAiBatchStatus>({
    url: `${baseUrl}/batches`,
    headers: buildBatchHeaders(params.openAi, { json: true }),
    ssrfPolicy: params.openAi.ssrfPolicy,
    fetchImpl: params.openAi.fetchImpl,
    body: {
      input_file_id: inputFileId,
      endpoint: OPENAI_BATCH_ENDPOINT,
      completion_window: OPENAI_BATCH_COMPLETION_WINDOW,
      metadata: {
        source: "openclaw-memory",
        agent: params.agentId,
      },
    },
    errorPrefix: "openai batch create failed",
  });
}

async function fetchOpenAiBatchStatus(params: {
  openAi: OpenAiEmbeddingClient;
  batchId: string;
}): Promise<OpenAiBatchStatus> {
  return await fetchOpenAiBatchResource({
    openAi: params.openAi,
    path: `/batches/${params.batchId}`,
    errorPrefix: "openai batch status",
    parse: async (res) => readProviderJsonResponse<OpenAiBatchStatus>(res, "openai.batch-status"),
  });
}

async function fetchOpenAiFileContent(params: {
  openAi: OpenAiEmbeddingClient;
  fileId: string;
}): Promise<string> {
  return await fetchOpenAiBatchResource({
    openAi: params.openAi,
    path: `/files/${params.fileId}/content`,
    errorPrefix: "openai batch file content",
    parse: async (res) => await readProviderTextResponse(res, "openai.batch-file-content"),
  });
}

async function readOpenAiBatchOutputLines(
  response: Response,
  params: {
    maxLines: number;
    onLine: (line: OpenAiBatchOutputLine) => boolean;
  },
): Promise<void> {
  let lineCount = 0;
  const emitOutputLine = (line: OpenAiBatchOutputLine): boolean => {
    lineCount += 1;
    if (lineCount > params.maxLines) {
      throw new Error(`openai.batch-file-content: JSONL output exceeds ${params.maxLines} records`);
    }
    return params.onLine(line);
  };
  const emitParsedLine = (line: string): boolean =>
    emitOutputLine(parseOpenAiBatchOutputLine(line));

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await readProviderTextResponse(response, "openai.batch-file-content", {
      maxBytes: OPENAI_BATCH_OUTPUT_LINE_MAX_BYTES,
    });
    for (const line of parseOpenAiBatchOutput(text)) {
      if (!emitOutputLine(line)) {
        break;
      }
    }
    return;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let line = "";
  let lineBytes = 0;

  const appendSegment = (segment: string) => {
    if (!segment) {
      return;
    }
    lineBytes += encoder.encode(segment).byteLength;
    if (lineBytes > OPENAI_BATCH_OUTPUT_LINE_MAX_BYTES) {
      throw new Error(
        `openai.batch-file-content: JSONL line exceeds ${OPENAI_BATCH_OUTPUT_LINE_MAX_BYTES} bytes`,
      );
    }
    line += segment;
  };
  const emitLine = (): boolean => {
    const trimmed = line.trim();
    line = "";
    lineBytes = 0;
    if (trimmed) {
      return emitParsedLine(trimmed);
    }
    return true;
  };
  const consumeText = (text: string): boolean => {
    let offset = 0;
    while (true) {
      const newline = text.indexOf("\n", offset);
      if (newline === -1) {
        appendSegment(text.slice(offset));
        return true;
      }
      appendSegment(text.slice(offset, newline));
      if (!emitLine()) {
        return false;
      }
      offset = newline + 1;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.byteLength > 0) {
        if (!consumeText(decoder.decode(value, { stream: true }))) {
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }
    if (!consumeText(decoder.decode())) {
      return;
    }
    if (line.trim()) {
      emitLine();
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readOpenAiBatchOutputFile(params: {
  openAi: OpenAiEmbeddingClient;
  fileId: string;
  maxLines: number;
  onLine: (line: OpenAiBatchOutputLine) => boolean;
}): Promise<void> {
  return await fetchOpenAiBatchResource({
    openAi: params.openAi,
    path: `/files/${params.fileId}/content`,
    errorPrefix: "openai batch file content",
    parse: async (res) =>
      await readOpenAiBatchOutputLines(res, {
        maxLines: params.maxLines,
        onLine: params.onLine,
      }),
  });
}

async function fetchOpenAiBatchResource<T>(params: {
  openAi: OpenAiEmbeddingClient;
  path: string;
  errorPrefix: string;
  parse: (res: Response) => Promise<T>;
}): Promise<T> {
  const baseUrl = normalizeBatchBaseUrl(params.openAi);
  return await withRemoteHttpResponse({
    url: `${baseUrl}${params.path}`,
    ssrfPolicy: params.openAi.ssrfPolicy,
    fetchImpl: params.openAi.fetchImpl,
    init: {
      headers: buildBatchHeaders(params.openAi, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await readResponseTextLimited(res, OPENAI_BATCH_ERROR_BODY_LIMIT_BYTES);
        throw new Error(`${params.errorPrefix} failed: ${res.status} ${text}`);
      }
      return await params.parse(res);
    },
  });
}

function formatOpenAiBatchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOpenAiBatchUploadTooLargeError(error: unknown): boolean {
  const message = formatOpenAiBatchError(error);
  if (!/openai batch file upload failed/i.test(message)) {
    return false;
  }
  return (
    /\b413\b/.test(message) ||
    /payload too large/i.test(message) ||
    /request body too large/i.test(message) ||
    /file too large/i.test(message) ||
    /maximum allowed/i.test(message) ||
    /max(?:imum)? (?:body|payload|file) (?:size )?(?:exceeded|limit)/i.test(message)
  );
}

export function parseOpenAiBatchOutput(text: string): OpenAiBatchOutputLine[] {
  if (!text.trim()) {
    return [];
  }
  return normalizeStringEntries(text.split("\n")).map(parseOpenAiBatchOutputLine);
}

function parseOpenAiBatchOutputLine(line: string): OpenAiBatchOutputLine {
  try {
    return JSON.parse(line) as OpenAiBatchOutputLine;
  } catch {
    throw new Error("OpenAI embedding batch output contained malformed JSONL");
  }
}

async function readOpenAiBatchError(params: {
  openAi: OpenAiEmbeddingClient;
  errorFileId: string;
}): Promise<string | undefined> {
  try {
    const content = await fetchOpenAiFileContent({
      openAi: params.openAi,
      fileId: params.errorFileId,
    });
    const lines = parseOpenAiBatchOutput(content);
    return extractBatchErrorMessage(lines);
  } catch (err) {
    return formatUnavailableBatchError(err);
  }
}

function createOpenAiBatchPollBackoff(params: { pollIntervalMs: number; timeoutMs: number }): {
  nextDelayMs: () => number;
} {
  const maxDelayMs = Math.max(
    params.pollIntervalMs,
    Math.min(params.timeoutMs, OPENAI_BATCH_MAX_POLL_BACKOFF_MS),
  );
  let delayMs = params.pollIntervalMs;
  return {
    nextDelayMs: () => {
      const current = delayMs;
      delayMs = Math.min(maxDelayMs, current * 2);
      return current;
    },
  };
}

function formatOpenAiBatchProgress(status: OpenAiBatchStatus): string {
  const counts = status.request_counts;
  if (!counts || typeof counts.total !== "number") {
    return "";
  }
  const completed = typeof counts.completed === "number" ? counts.completed : 0;
  const failed = typeof counts.failed === "number" ? counts.failed : 0;
  return `; progress ${completed}/${counts.total} failed=${failed}`;
}

function formatOpenAiBatchPollError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableOpenAiBatchPollError(error: unknown): boolean {
  const message = formatOpenAiBatchPollError(error);
  return (
    /openai batch status failed: (408|409|425|429|5\d\d)\b/i.test(message) ||
    /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b|fetch failed|network error/i.test(message)
  );
}

async function waitForOpenAiBatch(params: {
  openAi: OpenAiEmbeddingClient;
  batchId: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: OpenAiBatchStatus;
}): Promise<BatchCompletionResult> {
  const start = Date.now();
  const pollBackoff = createOpenAiBatchPollBackoff(params);
  let current: OpenAiBatchStatus | undefined = params.initial;
  while (true) {
    let status: OpenAiBatchStatus;
    try {
      status =
        current ??
        (await fetchOpenAiBatchStatus({
          openAi: params.openAi,
          batchId: params.batchId,
        }));
    } catch (error) {
      if (!params.wait || !isRetryableOpenAiBatchPollError(error)) {
        throw error;
      }
      if (Date.now() - start > params.timeoutMs) {
        throw new Error(`openai batch ${params.batchId} timed out after ${params.timeoutMs}ms`, {
          cause: error,
        });
      }
      const delayMs = pollBackoff.nextDelayMs();
      params.debug?.(
        `openai batch ${params.batchId} status check failed: ${formatOpenAiBatchPollError(
          error,
        )}; waiting ${delayMs}ms`,
      );
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
      current = undefined;
      continue;
    }
    const state = status.status ?? "unknown";
    if (state === "completed") {
      return resolveBatchCompletionFromStatus({
        provider: "openai",
        batchId: params.batchId,
        status,
      });
    }
    await throwIfBatchTerminalFailure({
      provider: "openai",
      status: { ...status, id: params.batchId },
      readError: async (errorFileId) =>
        await readOpenAiBatchError({
          openAi: params.openAi,
          errorFileId,
        }),
    });
    if (!params.wait) {
      throw new Error(`openai batch ${params.batchId} still ${state}; wait disabled`);
    }
    if (Date.now() - start > params.timeoutMs) {
      throw new Error(`openai batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
    }
    const delayMs = pollBackoff.nextDelayMs();
    params.debug?.(
      `openai batch ${params.batchId} ${state}${formatOpenAiBatchProgress(
        status,
      )}; waiting ${delayMs}ms`,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
    current = undefined;
  }
}

export async function runOpenAiEmbeddingBatches(
  params: {
    openAi: OpenAiEmbeddingClient;
    agentId: string;
    requests: OpenAiBatchRequest[];
    maxJsonlBytes?: number;
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: OPENAI_BATCH_MAX_REQUESTS,
      maxJsonlBytes: params.maxJsonlBytes ?? OPENAI_BATCH_MAX_JSONL_BYTES,
      debugLabel: "memory embeddings: openai batch submit",
    }),
    shouldSplitGroupOnError: isOpenAiBatchUploadTooLargeError,
    onSplitGroup: ({ error, group, parts, depth }) => {
      params.debug?.("memory embeddings: openai batch upload too large; splitting group", {
        requests: group.length,
        parts: parts.map((part) => part.length),
        depth,
        error: formatOpenAiBatchError(error),
      });
    },
    runGroup: async ({ group, groupIndex, groups, byCustomId, pollIntervalMs, timeoutMs }) => {
      const batchInfo = await submitOpenAiBatch({
        openAi: params.openAi,
        requests: group,
        agentId: params.agentId,
      });
      if (!batchInfo.id) {
        throw new Error("openai batch create failed: missing batch id");
      }
      const batchId = batchInfo.id;

      params.debug?.("memory embeddings: openai batch created", {
        batchId: batchInfo.id,
        status: batchInfo.status,
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      const completed = await resolveCompletedBatchResult({
        provider: "openai",
        status: batchInfo,
        wait: params.wait,
        waitForBatch: async () =>
          await waitForOpenAiBatch({
            openAi: params.openAi,
            batchId,
            wait: params.wait,
            pollIntervalMs,
            timeoutMs,
            debug: params.debug,
            initial: batchInfo,
          }),
      });

      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      await readOpenAiBatchOutputFile({
        openAi: params.openAi,
        fileId: completed.outputFileId,
        maxLines: group.length,
        onLine: (line) => {
          applyEmbeddingBatchOutputLine({ line, remaining, errors, byCustomId });
          return remaining.size > 0;
        },
      });

      if (errors.length > 0) {
        throw new Error(`openai batch ${batchInfo.id} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(
          `openai batch ${batchInfo.id} missing ${remaining.size} embedding responses`,
        );
      }
    },
  });
}
