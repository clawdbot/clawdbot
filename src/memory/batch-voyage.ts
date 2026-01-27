import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { retryAsync } from "../infra/retry.js";
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";
import { hashText, runWithConcurrency } from "./internal.js";

/**
 * Voyage Batch API Input Line format.
 * See: https://docs.voyageai.com/docs/batch-inference
 */
export type VoyageBatchRequest = {
  custom_id: string;
  body: {
    input: string | string[];
  };
};

export type VoyageBatchStatus = {
  id?: string;
  status?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
};

export type VoyageBatchOutputLine = {
  custom_id?: string;
  response?: {
    status_code?: number;
    body?: {
      data?: Array<{ embedding?: number[]; index?: number }>;
      error?: { message?: string };
    };
  };
  error?: { message?: string };
};

export const VOYAGE_BATCH_ENDPOINT = "/v1/embeddings";
const VOYAGE_BATCH_COMPLETION_WINDOW = "12h";
const VOYAGE_BATCH_MAX_REQUESTS = 50000;

function getVoyageBaseUrl(client: VoyageEmbeddingClient): string {
  return client.baseUrl?.replace(/\/$/, "") ?? "";
}

function getVoyageHeaders(
  client: VoyageEmbeddingClient,
  params: { json: boolean },
): Record<string, string> {
  const headers = client.headers ? { ...client.headers } : {};
  if (params.json) {
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
  } else {
    delete headers["Content-Type"];
    delete headers["content-type"];
  }
  return headers;
}

function splitVoyageBatchRequests(requests: VoyageBatchRequest[]): VoyageBatchRequest[][] {
  if (requests.length <= VOYAGE_BATCH_MAX_REQUESTS) return [requests];
  const groups: VoyageBatchRequest[][] = [];
  for (let i = 0; i < requests.length; i += VOYAGE_BATCH_MAX_REQUESTS) {
    groups.push(requests.slice(i, i + VOYAGE_BATCH_MAX_REQUESTS));
  }
  return groups;
}

async function submitVoyageBatch(params: {
  client: VoyageEmbeddingClient;
  requests: VoyageBatchRequest[];
  agentId: string;
}): Promise<VoyageBatchStatus> {
  const baseUrl = getVoyageBaseUrl(params.client);
  const jsonl = params.requests.map((request) => JSON.stringify(request)).join("\n");
  const form = new FormData();
  form.append("purpose", "batch");
  form.append(
    "file",
    new Blob([jsonl], { type: "application/jsonl" }),
    `memory-embeddings.${hashText(String(Date.now()))}.jsonl`,
  );

  // 1. Upload file using Voyage Files API
  const fileRes = await fetch(`${baseUrl}/files`, {
    method: "POST",
    headers: getVoyageHeaders(params.client, { json: false }),
    body: form,
  });
  if (!fileRes.ok) {
    const text = await fileRes.text();
    throw new Error(`voyage batch file upload failed: ${fileRes.status} ${text}`);
  }
  const filePayload = (await fileRes.json()) as { id?: string };
  if (!filePayload.id) {
    throw new Error("voyage batch file upload failed: missing file id");
  }

  // 2. Create batch job using Voyage Batches API
  const batchRes = await retryAsync(
    async () => {
      const res = await fetch(`${baseUrl}/batches`, {
        method: "POST",
        headers: getVoyageHeaders(params.client, { json: true }),
        body: JSON.stringify({
          input_file_id: filePayload.id,
          endpoint: VOYAGE_BATCH_ENDPOINT,
          completion_window: VOYAGE_BATCH_COMPLETION_WINDOW,
          request_params: {
            model: params.client.model,
          },
          metadata: {
            source: "clawdbot-memory",
            agent: params.agentId,
          },
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`voyage batch create failed: ${res.status} ${text}`) as Error & {
          status?: number;
        };
        err.status = res.status;
        throw err;
      }
      return res;
    },
    {
      attempts: 3,
      minDelayMs: 300,
      maxDelayMs: 2000,
      jitter: 0.2,
      shouldRetry: (err) => {
        const status = (err as { status?: number }).status;
        return status === 429 || (typeof status === "number" && status >= 500);
      },
    },
  );
  return (await batchRes.json()) as VoyageBatchStatus;
}

async function fetchVoyageBatchStatus(params: {
  client: VoyageEmbeddingClient;
  batchId: string;
}): Promise<VoyageBatchStatus> {
  const baseUrl = getVoyageBaseUrl(params.client);
  const res = await fetch(`${baseUrl}/batches/${params.batchId}`, {
    headers: getVoyageHeaders(params.client, { json: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`voyage batch status failed: ${res.status} ${text}`);
  }
  return (await res.json()) as VoyageBatchStatus;
}

async function readVoyageBatchError(params: {
  client: VoyageEmbeddingClient;
  errorFileId: string;
}): Promise<string | undefined> {
  try {
    const baseUrl = getVoyageBaseUrl(params.client);
    const res = await fetch(`${baseUrl}/files/${params.errorFileId}/content`, {
      headers: getVoyageHeaders(params.client, { json: true }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`voyage batch error file content failed: ${res.status} ${text}`);
    }
    const text = await res.text();
    if (!text.trim()) return undefined;
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as VoyageBatchOutputLine);
    const first = lines.find((line) => line.error?.message || line.response?.body?.error);
    const message =
      first?.error?.message ??
      (typeof first?.response?.body?.error?.message === "string"
        ? first?.response?.body?.error?.message
        : undefined);
    return message;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message ? `error file unavailable: ${message}` : undefined;
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
}): Promise<{ outputFileId: string; errorFileId?: string }> {
  const start = Date.now();
  let current: VoyageBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchVoyageBatchStatus({
        client: params.client,
        batchId: params.batchId,
      }));
    const state = status.status ?? "unknown";
    if (state === "completed") {
      if (!status.output_file_id) {
        throw new Error(`voyage batch ${params.batchId} completed without output file`);
      }
      return {
        outputFileId: status.output_file_id,
        errorFileId: status.error_file_id ?? undefined,
      };
    }
    if (["failed", "expired", "cancelled", "canceled"].includes(state)) {
      const detail = status.error_file_id
        ? await readVoyageBatchError({ client: params.client, errorFileId: status.error_file_id })
        : undefined;
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`voyage batch ${params.batchId} ${state}${suffix}`);
    }
    if (!params.wait) {
      throw new Error(`voyage batch ${params.batchId} still ${state}; wait disabled`);
    }
    if (Date.now() - start > params.timeoutMs) {
      throw new Error(`voyage batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
    }
    params.debug?.(`voyage batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
    current = undefined;
  }
}

export async function runVoyageEmbeddingBatches(params: {
  client: VoyageEmbeddingClient;
  agentId: string;
  requests: VoyageBatchRequest[];
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<Map<string, number[]>> {
  if (params.requests.length === 0) return new Map();
  const groups = splitVoyageBatchRequests(params.requests);
  const byCustomId = new Map<string, number[]>();

  const tasks = groups.map((group, groupIndex) => async () => {
    const batchInfo = await submitVoyageBatch({
      client: params.client,
      requests: group,
      agentId: params.agentId,
    });
    if (!batchInfo.id) {
      throw new Error("voyage batch create failed: missing batch id");
    }

    params.debug?.("memory embeddings: voyage batch created", {
      batchId: batchInfo.id,
      status: batchInfo.status,
      group: groupIndex + 1,
      groups: groups.length,
      requests: group.length,
    });

    if (!params.wait && batchInfo.status !== "completed") {
      throw new Error(
        `voyage batch ${batchInfo.id} submitted; enable remote.batch.wait to await completion`,
      );
    }

    const completed =
      batchInfo.status === "completed"
        ? {
            outputFileId: batchInfo.output_file_id ?? "",
            errorFileId: batchInfo.error_file_id ?? undefined,
          }
        : await waitForVoyageBatch({
            client: params.client,
            batchId: batchInfo.id,
            wait: params.wait,
            pollIntervalMs: params.pollIntervalMs,
            timeoutMs: params.timeoutMs,
            debug: params.debug,
            initial: batchInfo,
          });
    if (!completed.outputFileId) {
      throw new Error(`voyage batch ${batchInfo.id} completed without output file`);
    }

    const baseUrl = getVoyageBaseUrl(params.client);
    const contentRes = await fetch(`${baseUrl}/files/${completed.outputFileId}/content`, {
      headers: getVoyageHeaders(params.client, { json: true }),
    });
    if (!contentRes.ok) {
      const text = await contentRes.text();
      throw new Error(`voyage batch file content failed: ${contentRes.status} ${text}`);
    }

    const errors: string[] = [];
    const remaining = new Set(group.map((request) => request.custom_id));

    if (contentRes.body) {
      const reader = createInterface({
        input: Readable.fromWeb(contentRes.body as any),
        terminal: false,
      });

      for await (const rawLine of reader) {
        if (!rawLine.trim()) continue;
        const line = JSON.parse(rawLine) as VoyageBatchOutputLine;
        const customId = line.custom_id;
        if (!customId) continue;
        remaining.delete(customId);
        if (line.error?.message) {
          errors.push(`${customId}: ${line.error.message}`);
          continue;
        }
        const response = line.response;
        const statusCode = response?.status_code ?? 0;
        if (statusCode >= 400) {
          const message =
            response?.body?.error?.message ??
            (typeof response?.body === "string" ? response.body : undefined) ??
            "unknown error";
          errors.push(`${customId}: ${message}`);
          continue;
        }
        const data = response?.body?.data ?? [];
        const embedding = data[0]?.embedding ?? [];
        if (embedding.length === 0) {
          errors.push(`${customId}: empty embedding`);
          continue;
        }
        byCustomId.set(customId, embedding);
      }
    }

    if (errors.length > 0) {
      throw new Error(`voyage batch ${batchInfo.id} failed: ${errors.join("; ")}`);
    }
    if (remaining.size > 0) {
      throw new Error(`voyage batch ${batchInfo.id} missing ${remaining.size} embedding responses`);
    }
  });

  params.debug?.("memory embeddings: voyage batch submit", {
    requests: params.requests.length,
    groups: groups.length,
    wait: params.wait,
    concurrency: params.concurrency,
    pollIntervalMs: params.pollIntervalMs,
    timeoutMs: params.timeoutMs,
  });

  await runWithConcurrency(tasks, params.concurrency);
  return byCustomId;
}
