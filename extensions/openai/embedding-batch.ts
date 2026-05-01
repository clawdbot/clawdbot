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

type OpenAiBatchStatus = EmbeddingBatchStatus;
type OpenAiBatchOutputLine = ProviderBatchOutputLine;

export const OPENAI_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const OPENAI_BATCH_COMPLETION_WINDOW = "24h";
const OPENAI_BATCH_MAX_REQUESTS = 50000;

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
    parse: async (res) => (await res.json()) as OpenAiBatchStatus,
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
    parse: async (res) => await res.text(),
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
        const text = await res.text();
        throw new Error(`${params.errorPrefix} failed: ${res.status} ${text}`);
      }
      return await params.parse(res);
    },
  });
}

function parseOpenAiBatchOutput(text: string): OpenAiBatchOutputLine[] {
  if (!text.trim()) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OpenAiBatchOutputLine);
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
  let current: OpenAiBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchOpenAiBatchStatus({
        openAi: params.openAi,
        batchId: params.batchId,
      }));
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
    params.debug?.(`openai batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
    current = undefined;
  }
}

export async function runOpenAiEmbeddingBatches(
  params: {
    openAi: OpenAiEmbeddingClient;
    agentId: string;
    requests: OpenAiBatchRequest[];
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: OPENAI_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: openai batch submit",
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
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
            pollIntervalMs: params.pollIntervalMs,
            timeoutMs: params.timeoutMs,
            debug: params.debug,
            initial: batchInfo,
          }),
      });

      const content = await fetchOpenAiFileContent({
        openAi: params.openAi,
        fileId: completed.outputFileId,
      });
      const outputLines = parseOpenAiBatchOutput(content);
      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      for (const line of outputLines) {
        applyEmbeddingBatchOutputLine({ line, remaining, errors, byCustomId });
      }

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
