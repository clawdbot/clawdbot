import type { MistralEmbeddingClient } from "./embeddings-mistral.js";
import { hashText } from "./internal.js";

export type MistralBatchRequest = {
  custom_id: string;
  text: string;
};

export type MistralBatchStatus = {
  id?: string;
  status?: string;
  output?: Map<string, number[]>;
  error?: string;
};

const MISTRAL_BATCH_MAX_REQUESTS = 100;

function getMistralBaseUrl(mistral: MistralEmbeddingClient): string {
  return mistral.baseUrl?.replace(/\/$/, "") ?? "";
}

function getMistralHeaders(mistral: MistralEmbeddingClient): Record<string, string> {
  const headers = mistral.headers ? { ...mistral.headers } : {};
  if (!headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function splitMistralBatchRequests(requests: MistralBatchRequest[]): MistralBatchRequest[][] {
  if (requests.length <= MISTRAL_BATCH_MAX_REQUESTS) return [requests];
  const groups: MistralBatchRequest[][] = [];
  for (let i = 0; i < requests.length; i += MISTRAL_BATCH_MAX_REQUESTS) {
    groups.push(requests.slice(i, i + MISTRAL_BATCH_MAX_REQUESTS));
  }
  return groups;
}

async function submitMistralBatch(params: {
  mistral: MistralEmbeddingClient;
  requests: MistralBatchRequest[];
}): Promise<Map<string, number[]>> {
  if (params.requests.length === 0) return new Map();

  const baseUrl = getMistralBaseUrl(params.mistral);
  const url = `${baseUrl}/embeddings`;

  const byCustomId = new Map<string, number[]>();

  // Process all requests in one batch API call
  const inputTexts = params.requests.map((req) => req.text);

  const res = await fetch(url, {
    method: "POST",
    headers: getMistralHeaders(params.mistral),
    body: JSON.stringify({
      model: params.mistral.model,
      input: inputTexts,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`mistral batch failed: ${res.status} ${text}`);
  }

  const payload = (await res.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
    error?: { message?: string };
  };

  if (payload.error?.message) {
    throw new Error(`mistral batch failed: ${payload.error.message}`);
  }

  const data = payload.data ?? [];
  if (data.length !== params.requests.length) {
    throw new Error(
      `mistral batch failed: expected ${params.requests.length} results, got ${data.length}`,
    );
  }

  // Map results back to custom IDs
  for (let i = 0; i < data.length; i++) {
    const result = data[i];
    const customId = params.requests[i].custom_id;
    const embedding = result.embedding ?? [];
    if (embedding.length === 0) {
      throw new Error(`mistral batch failed: empty embedding for ${customId}`);
    }
    byCustomId.set(customId, embedding);
  }

  return byCustomId;
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  if (tasks.length === 0) return [];
  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  let firstError: unknown = null;

  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      if (firstError) return;
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        firstError = err;
        return;
      }
    }
  });

  await Promise.allSettled(workers);
  if (firstError) throw firstError;
  return results;
}

export async function runMistralEmbeddingBatches(params: {
  mistral: MistralEmbeddingClient;
  agentId: string;
  requests: MistralBatchRequest[];
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<Map<string, number[]>> {
  if (params.requests.length === 0) return new Map();

  const groups = splitMistralBatchRequests(params.requests);
  const byCustomId = new Map<string, number[]>();

  const tasks = groups.map((group, groupIndex) => async () => {
    params.debug?.("memory embeddings: mistral batch start", {
      group: groupIndex + 1,
      groups: groups.length,
      requests: group.length,
    });

    const results = await submitMistralBatch({
      mistral: params.mistral,
      requests: group,
    });

    params.debug?.("memory embeddings: mistral batch complete", {
      group: groupIndex + 1,
      results: results.size,
    });

    // Merge results into main map
    for (const [customId, embedding] of results.entries()) {
      byCustomId.set(customId, embedding);
    }
  });

  params.debug?.("memory embeddings: mistral batch submit", {
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
