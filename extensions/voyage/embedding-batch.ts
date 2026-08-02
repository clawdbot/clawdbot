// Voyage plugin module implements embedding batch behavior.
import {
  applyEmbeddingBatchOutputLine,
  buildBatchHeaders,
  buildEmbeddingBatchGroupOptions,
  EMBEDDING_BATCH_ENDPOINT,
  extractBatchErrorMessage,
  formatBatchErrorDetail,
  formatUnavailableBatchError,
  normalizeBatchBaseUrl,
  postJsonWithRetry,
  readEmbeddingBatchJsonl,
  resolveBatchCompletionFromStatus,
  resolveCompletedBatchResult,
  runEmbeddingBatchGroups,
  throwIfBatchCompletionError,
  throwIfBatchTerminalFailure,
  type EmbeddingBatchExecutionParams,
  type EmbeddingBatchStatus,
  type BatchCompletionResult,
  type ProviderBatchOutputLine,
  uploadBatchJsonlFile,
  withRemoteHttpResponse,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { VoyageEmbeddingClient } from "./embedding-provider.js";

/**
 * Voyage Batch API Input Line format.
 * See: https://docs.voyageai.com/docs/batch-inference
 */
type VoyageBatchRequest = {
  custom_id: string;
  body: {
    input: string | string[];
  };
};

type VoyageBatchStatus = EmbeddingBatchStatus;
type VoyageBatchOutputLine = ProviderBatchOutputLine;

const VOYAGE_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const VOYAGE_BATCH_COMPLETION_WINDOW = "12h";
const VOYAGE_BATCH_MAX_REQUESTS = 50000;
// Successful status/error-file responses are untrusted external bodies. Cap
// them at 16 MiB; non-OK diagnostics use the shared bounded provider prefix.
const VOYAGE_BATCH_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

type VoyageBatchDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  postJsonWithRetry: typeof postJsonWithRetry<VoyageBatchStatus>;
  uploadBatchJsonlFile: typeof uploadBatchJsonlFile;
  withRemoteHttpResponse: typeof withRemoteHttpResponse;
};

function resolveVoyageBatchDeps(overrides: Partial<VoyageBatchDeps> | undefined): VoyageBatchDeps {
  return {
    now: overrides?.now ?? Date.now,
    sleep:
      overrides?.sleep ??
      (async (ms: number) =>
        await new Promise((resolve) => {
          setTimeout(resolve, ms);
        })),
    postJsonWithRetry: overrides?.postJsonWithRetry ?? postJsonWithRetry,
    uploadBatchJsonlFile: overrides?.uploadBatchJsonlFile ?? uploadBatchJsonlFile,
    withRemoteHttpResponse: overrides?.withRemoteHttpResponse ?? withRemoteHttpResponse,
  };
}

function buildVoyageBatchRequest<T>(params: {
  client: VoyageEmbeddingClient;
  path: string;
  signal?: AbortSignal;
  onResponse: (res: Response) => Promise<T>;
}) {
  const baseUrl = normalizeBatchBaseUrl(params.client);
  return {
    url: `${baseUrl}/${params.path}`,
    ssrfPolicy: params.client.ssrfPolicy,
    signal: params.signal,
    init: {
      headers: buildBatchHeaders(params.client, { json: true }),
    },
    onResponse: params.onResponse,
  };
}

async function submitVoyageBatch(params: {
  client: VoyageEmbeddingClient;
  requests: VoyageBatchRequest[];
  agentId: string;
  deps: VoyageBatchDeps;
}): Promise<VoyageBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.client);
  const inputFileId = await params.deps.uploadBatchJsonlFile({
    client: params.client,
    requests: params.requests,
    errorPrefix: "voyage batch file upload failed",
  });

  // 2. Create batch job using Voyage Batches API
  return await params.deps.postJsonWithRetry({
    url: `${baseUrl}/batches`,
    headers: buildBatchHeaders(params.client, { json: true }),
    ssrfPolicy: params.client.ssrfPolicy,
    body: {
      input_file_id: inputFileId,
      endpoint: VOYAGE_BATCH_ENDPOINT,
      completion_window: VOYAGE_BATCH_COMPLETION_WINDOW,
      request_params: {
        model: params.client.model,
        input_type: "document",
      },
      metadata: {
        source: "clawdbot-memory",
        agent: params.agentId,
      },
    },
    errorPrefix: "voyage batch create failed",
  });
}

async function fetchVoyageBatchStatus(params: {
  client: VoyageEmbeddingClient;
  batchId: string;
  deps: VoyageBatchDeps;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}): Promise<VoyageBatchStatus> {
  const maxBytes = params.maxResponseBytes ?? VOYAGE_BATCH_RESPONSE_MAX_BYTES;
  return await params.deps.withRemoteHttpResponse(
    buildVoyageBatchRequest({
      client: params.client,
      path: `batches/${params.batchId}`,
      signal: params.signal,
      onResponse: async (res) => {
        await assertOkOrThrowProviderError(res, "voyage.batch-status");
        return await readProviderJsonResponse<VoyageBatchStatus>(res, "voyage-batch-status", {
          maxBytes,
        });
      },
    }),
  );
}

async function readVoyageBatchError(params: {
  client: VoyageEmbeddingClient;
  errorFileId: string;
  deps: VoyageBatchDeps;
  maxResponseBytes?: number;
}): Promise<string | undefined> {
  const maxBytes = params.maxResponseBytes ?? VOYAGE_BATCH_RESPONSE_MAX_BYTES;
  try {
    return await params.deps.withRemoteHttpResponse(
      buildVoyageBatchRequest({
        client: params.client,
        path: `files/${params.errorFileId}/content`,
        onResponse: async (res) => {
          await assertOkOrThrowProviderError(res, "voyage.batch-error-file-content");
          const bytes = await readResponseWithLimit(res, maxBytes, {
            onOverflow: ({ maxBytes: maxBytesLocal }) =>
              new Error(`voyage batch error file content exceeds ${maxBytesLocal} bytes`),
          });
          const text = new TextDecoder().decode(bytes);
          if (!text.trim()) {
            return undefined;
          }
          const lines = normalizeStringEntries(text.split("\n")).map(
            (line) => JSON.parse(line) as VoyageBatchOutputLine,
          );
          return formatBatchErrorDetail(extractBatchErrorMessage(lines));
        },
      }),
    );
  } catch (err) {
    return formatUnavailableBatchError(err);
  }
}

async function waitForVoyageBatch(params: {
  client: VoyageEmbeddingClient;
  batchId: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: VoyageBatchStatus;
  deps: VoyageBatchDeps;
}): Promise<BatchCompletionResult> {
  const start = params.deps.now();
  const deadline = start + params.timeoutMs;
  let current: VoyageBatchStatus | undefined = params.initial;
  while (true) {
    let status: VoyageBatchStatus;
    if (current) {
      status = current;
    } else {
      const remainingRequestMs = deadline - params.deps.now();
      if (remainingRequestMs <= 0) {
        throw new Error(`voyage batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
      }
      const signal = AbortSignal.timeout(Math.max(1, remainingRequestMs));
      try {
        status = await fetchVoyageBatchStatus({
          client: params.client,
          batchId: params.batchId,
          deps: params.deps,
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          throw new Error(`voyage batch ${params.batchId} timed out after ${params.timeoutMs}ms`, {
            cause: error,
          });
        }
        throw error;
      }
    }
    const state = status.status ?? "unknown";
    await throwIfBatchCompletionError({
      provider: "voyage",
      status: { ...status, id: params.batchId },
      readError: async (errorFileId) =>
        await readVoyageBatchError({
          client: params.client,
          errorFileId,
          deps: params.deps,
        }),
    });
    if (state === "completed") {
      return resolveBatchCompletionFromStatus({
        provider: "voyage",
        batchId: params.batchId,
        status,
      });
    }
    await throwIfBatchTerminalFailure({
      provider: "voyage",
      status: { ...status, id: params.batchId },
      readError: async (errorFileId) =>
        await readVoyageBatchError({
          client: params.client,
          errorFileId,
          deps: params.deps,
        }),
    });
    if (!params.wait) {
      throw new Error(`voyage batch ${params.batchId} still ${state}; wait disabled`);
    }
    const remainingMs = deadline - params.deps.now();
    if (remainingMs <= 0) {
      throw new Error(`voyage batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
    }
    const waitMs = Math.min(params.pollIntervalMs, remainingMs);
    params.debug?.(`voyage batch ${params.batchId} ${state}; waiting ${waitMs}ms`);
    await params.deps.sleep(waitMs);
    current = undefined;
  }
}

export async function runVoyageEmbeddingBatches(
  params: {
    client: VoyageEmbeddingClient;
    agentId: string;
    requests: VoyageBatchRequest[];
    deps?: Partial<VoyageBatchDeps>;
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  const deps = resolveVoyageBatchDeps(params.deps);
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      maxRequests: VOYAGE_BATCH_MAX_REQUESTS,
      debugLabel: "memory embeddings: voyage batch submit",
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId, pollIntervalMs, timeoutMs }) => {
      const batchInfo = await submitVoyageBatch({
        client: params.client,
        requests: group,
        agentId: params.agentId,
        deps,
      });
      if (!batchInfo.id) {
        throw new Error("voyage batch create failed: missing batch id");
      }
      const batchId = batchInfo.id;

      params.debug?.("memory embeddings: voyage batch created", {
        batchId: batchInfo.id,
        status: batchInfo.status,
        group: groupIndex + 1,
        groups,
        requests: group.length,
      });

      await throwIfBatchCompletionError({
        provider: "voyage",
        status: batchInfo,
        readError: async (errorFileId) =>
          await readVoyageBatchError({ client: params.client, errorFileId, deps }),
      });

      const completed = await resolveCompletedBatchResult({
        provider: "voyage",
        status: batchInfo,
        wait: params.wait,
        waitForBatch: async () =>
          await waitForVoyageBatch({
            client: params.client,
            batchId,
            wait: params.wait,
            pollIntervalMs,
            timeoutMs,
            debug: params.debug,
            initial: batchInfo,
            deps,
          }),
      });

      const baseUrl = normalizeBatchBaseUrl(params.client);
      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      await deps.withRemoteHttpResponse({
        url: `${baseUrl}/files/${completed.outputFileId}/content`,
        ssrfPolicy: params.client.ssrfPolicy,
        init: {
          headers: buildBatchHeaders(params.client, { json: true }),
        },
        onResponse: async (contentRes) => {
          await assertOkOrThrowProviderError(contentRes, "voyage.batch-file-content");

          await readEmbeddingBatchJsonl<VoyageBatchOutputLine>(contentRes, {
            label: "voyage.batch-file-content",
            maxRecords: group.length,
            onRecord: (line) => {
              // Only the first response for a submitted id may mutate results.
              if (line.custom_id && remaining.has(line.custom_id)) {
                applyEmbeddingBatchOutputLine({ line, remaining, errors, byCustomId });
              }
              return errors.length === 0 && remaining.size > 0;
            },
          });
        },
      });

      if (errors.length > 0) {
        throw new Error(
          `voyage batch ${batchInfo.id} failed: ${formatBatchErrorDetail(errors[0]) ?? "unknown error"}`,
        );
      }
      if (remaining.size > 0) {
        throw new Error(
          `voyage batch ${batchInfo.id} missing ${remaining.size} embedding responses`,
        );
      }
    },
  });
}

const testing = {
  fetchVoyageBatchStatus,
  readVoyageBatchError,
  VOYAGE_BATCH_RESPONSE_MAX_BYTES,
} as const;

if (process.env.VITEST === "true") {
  Reflect.set(globalThis, Symbol.for("openclaw.voyageEmbeddingBatchTestApi"), testing);
}
