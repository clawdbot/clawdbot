import { coerceErrorMessage as formatOpenAiBatchError } from "openclaw/plugin-sdk/error-runtime";
// Openai plugin module implements embedding batch behavior.
import {
  applyEmbeddingBatchOutputLine,
  buildBatchHeaders,
  buildEmbeddingBatchGroupOptions,
  EMBEDDING_BATCH_ENDPOINT,
  extractBatchErrorMessage,
  formatBatchErrorDetail,
  formatUnavailableBatchError,
  postJsonWithRetry,
  readEmbeddingBatchJsonl,
  resolveEmbeddingEndpointUrl,
  resolveCompletedBatchResult,
  runEmbeddingBatchGroups,
  throwIfBatchCompletionError,
  type EmbeddingBatchExecutionParams,
  type EmbeddingBatchStatus,
  type ProviderBatchOutputLine,
  uploadBatchJsonlFile,
  waitForEmbeddingBatch,
  withRemoteHttpResponse,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  assertOkOrThrowProviderError,
  createProviderOperationDeadline,
  readProviderJsonResponse,
  readProviderTextResponse,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenAiEmbeddingClient } from "./embedding-provider.js";

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

async function submitOpenAiBatch(params: {
  openAi: OpenAiEmbeddingClient;
  requests: OpenAiBatchRequest[];
  agentId: string;
}): Promise<OpenAiBatchStatus> {
  const inputFileId = await uploadBatchJsonlFile({
    client: params.openAi,
    requests: params.requests,
    errorPrefix: "openai batch file upload failed",
  });

  return await postJsonWithRetry<OpenAiBatchStatus>({
    url: resolveEmbeddingEndpointUrl(params.openAi.baseUrl, "batches"),
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
  signal?: AbortSignal;
}): Promise<OpenAiBatchStatus> {
  return await fetchOpenAiBatchResource({
    openAi: params.openAi,
    path: `/batches/${params.batchId}`,
    label: "openai.batch-status",
    signal: params.signal,
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
    label: "openai.batch-file-content",
    parse: async (res) => await readProviderTextResponse(res, "openai.batch-file-content"),
  });
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
    label: "openai.batch-file-content",
    parse: async (res) =>
      await readEmbeddingBatchJsonl<OpenAiBatchOutputLine>(res, {
        label: "openai.batch-file-content",
        maxRecords: params.maxLines,
        onRecord: params.onLine,
      }),
  });
}

async function fetchOpenAiBatchResource<T>(params: {
  openAi: OpenAiEmbeddingClient;
  path: string;
  label: string;
  signal?: AbortSignal;
  parse: (res: Response) => Promise<T>;
}): Promise<T> {
  return await withRemoteHttpResponse({
    url: resolveEmbeddingEndpointUrl(params.openAi.baseUrl, params.path),
    ssrfPolicy: params.openAi.ssrfPolicy,
    fetchImpl: params.openAi.fetchImpl,
    signal: params.signal,
    init: {
      headers: buildBatchHeaders(params.openAi, { json: true }),
    },
    onResponse: async (res) => {
      await assertOkOrThrowProviderError(res, params.label);
      return await params.parse(res);
    },
  });
}

function formatOpenAiBatchDiagnostic(error: unknown): string {
  return formatBatchErrorDetail(formatOpenAiBatchError(error)) ?? "unknown error";
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

function parseOpenAiBatchOutput(text: string): OpenAiBatchOutputLine[] {
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
    return formatBatchErrorDetail(extractBatchErrorMessage(lines));
  } catch (err) {
    return formatUnavailableBatchError(err);
  }
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

function isRetryableOpenAiBatchPollError(error: unknown): boolean {
  const message = formatOpenAiBatchError(error);
  const status =
    error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  return (
    (typeof status === "number" &&
      (status === 408 ||
        status === 409 ||
        status === 425 ||
        status === 429 ||
        (status >= 500 && status <= 599))) ||
    /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b|fetch failed|network error/i.test(message)
  );
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
        error: formatOpenAiBatchDiagnostic(error),
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

      await throwIfBatchCompletionError({
        provider: "openai",
        status: batchInfo,
        readError: async (errorFileId) =>
          await readOpenAiBatchError({ openAi: params.openAi, errorFileId }),
      });

      const completed = await resolveCompletedBatchResult({
        provider: "openai",
        status: batchInfo,
        wait: params.wait,
        waitForBatch: async () => {
          const openAi = params.openAi;
          const wait = params.wait;
          const debug = params.debug;
          const deadline = createProviderOperationDeadline({
            label: `openai batch ${batchId}`,
            timeoutMs,
          });
          return await waitForEmbeddingBatch({
            provider: "openai",
            batchId,
            wait,
            pollIntervalMs,
            timeoutMs,
            debug,
            initial: batchInfo,
            fetchStatus: (signal) => fetchOpenAiBatchStatus({ openAi, batchId, signal }),
            resolveTimeoutMs: () =>
              resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: timeoutMs }),
            waitForPoll: (delayMs) =>
              waitProviderOperationPollInterval({ deadline, pollIntervalMs: delayMs }),
            readError: async (errorFileId) => await readOpenAiBatchError({ openAi, errorFileId }),
            backoff: {
              maxDelayMs: OPENAI_BATCH_MAX_POLL_BACKOFF_MS,
              shouldRetry: isRetryableOpenAiBatchPollError,
              formatError: formatOpenAiBatchDiagnostic,
              formatProgress: formatOpenAiBatchProgress,
            },
          });
        },
      });

      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      await readOpenAiBatchOutputFile({
        openAi: params.openAi,
        fileId: completed.outputFileId,
        maxLines: group.length,
        onLine: (line) => {
          // Only the first response for a submitted id may mutate results.
          if (line.custom_id && remaining.has(line.custom_id)) {
            applyEmbeddingBatchOutputLine({ line, remaining, errors, byCustomId });
          }
          return errors.length === 0 && remaining.size > 0;
        },
      });

      if (errors.length > 0) {
        throw new Error(
          `openai batch ${batchInfo.id} failed: ${formatBatchErrorDetail(errors[0]) ?? "unknown error"}`,
        );
      }
      if (remaining.size > 0) {
        throw new Error(
          `openai batch ${batchInfo.id} missing ${remaining.size} embedding responses`,
        );
      }
    },
  });
}
