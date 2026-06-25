// Voyage plugin module implements embedding batch behavior.
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
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
  type EmbeddingBatchExecutionParams,
  type EmbeddingBatchStatus,
  type BatchCompletionResult,
  type ProviderBatchOutputLine,
  uploadBatchJsonlFile,
  withRemoteHttpResponse,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
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
// Voyage batch status/error responses are untrusted external bodies. Cap them
// the same way other bundled providers do (16 MiB) so a misbehaving or hostile
// endpoint cannot stream an unbounded body into memory before we parse it.
const VOYAGE_BATCH_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

type VoyageBatchDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  postJsonWithRetry: typeof postJsonWithRetry;
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

async function assertVoyageResponseOk(
  res: Response,
  context: string,
  maxBytes: number = VOYAGE_BATCH_RESPONSE_MAX_BYTES,
): Promise<void> {
  if (!res.ok) {
    // The non-OK diagnostic body is just as untrusted as the success body: a
    // misbehaving or hostile endpoint can return a 4xx/5xx with an unbounded
    // body, and the old `await res.text()` buffered it whole before we threw.
    // Read it through the same bounded reader (16 MiB cap, stream cancelled on
    // overflow) while preserving the original `${context}: ${status} ${text}`
    // diagnostic shape for backward compatibility.
    const bytes = await readResponseWithLimit(res, maxBytes, {
      onOverflow: ({ maxBytes: maxBytesLocal }) =>
        new Error(`${context}: ${res.status} (error body exceeds ${maxBytesLocal} bytes)`),
    });
    const text = new TextDecoder().decode(bytes);
    throw new Error(`${context}: ${res.status} ${text}`);
  }
}

function buildVoyageBatchRequest<T>(params: {
  client: VoyageEmbeddingClient;
  path: string;
  onResponse: (res: Response) => Promise<T>;
}) {
  const baseUrl = normalizeBatchBaseUrl(params.client);
  return {
    url: `${baseUrl}/${params.path}`,
    ssrfPolicy: params.client.ssrfPolicy,
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
  return await params.deps.postJsonWithRetry<VoyageBatchStatus>({
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
}): Promise<VoyageBatchStatus> {
  const maxBytes = params.maxResponseBytes ?? VOYAGE_BATCH_RESPONSE_MAX_BYTES;
  return await params.deps.withRemoteHttpResponse(
    buildVoyageBatchRequest({
      client: params.client,
      path: `batches/${params.batchId}`,
      onResponse: async (res) => {
        await assertVoyageResponseOk(res, "voyage batch status failed", maxBytes);
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
          await assertVoyageResponseOk(res, "voyage batch error file content failed", maxBytes);
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
          return extractBatchErrorMessage(lines);
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
  let current: VoyageBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchVoyageBatchStatus({
        client: params.client,
        batchId: params.batchId,
        deps: params.deps,
      }));
    const state = status.status ?? "unknown";
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
    if (params.deps.now() - start > params.timeoutMs) {
      throw new Error(`voyage batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
    }
    params.debug?.(`voyage batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
    await params.deps.sleep(params.pollIntervalMs);
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
          // Same bounded non-OK diagnostic read as the status/error-file paths:
          // the failure body is untrusted, so cap it instead of `await text()`.
          await assertVoyageResponseOk(contentRes, "voyage batch file content failed");

          if (!contentRes.body) {
            return;
          }
          const reader = createInterface({
            input: Readable.fromWeb(
              contentRes.body as unknown as import("stream/web").ReadableStream,
            ),
            terminal: false,
          });

          for await (const rawLine of reader) {
            if (!rawLine.trim()) {
              continue;
            }
            const line = JSON.parse(rawLine) as VoyageBatchOutputLine;
            applyEmbeddingBatchOutputLine({ line, remaining, errors, byCustomId });
          }
        },
      });

      if (errors.length > 0) {
        throw new Error(`voyage batch ${batchInfo.id} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(
          `voyage batch ${batchInfo.id} missing ${remaining.size} embedding responses`,
        );
      }
    },
  });
}

export const testing = {
  fetchVoyageBatchStatus,
  readVoyageBatchError,
  VOYAGE_BATCH_RESPONSE_MAX_BYTES,
} as const;
