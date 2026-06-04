// Parses provider batch output lines into the custom-id embedding map.

/** Minimal OpenAI-compatible embedding batch output line. */
export type EmbeddingBatchOutputLine = {
  custom_id?: string;
  error?: { message?: string };
  response?: {
    status_code?: number;
    body?:
      | {
          data?: Array<{
            embedding?: number[];
          }>;
          error?: { message?: string };
        }
      | string;
  };
};

/** Apply one output line, collecting errors and successful embeddings by custom id. */
export function applyEmbeddingBatchOutputLine(params: {
  line: EmbeddingBatchOutputLine;
  remaining: Set<string>;
  errors: string[];
  byCustomId: Map<string, number[]>;
}) {
  const customId = params.line.custom_id;
  if (!customId) {
    return;
  }
  params.remaining.delete(customId);

  const errorMessage = params.line.error?.message;
  if (errorMessage) {
    params.errors.push(`${customId}: ${errorMessage}`);
    return;
  }

  const response = params.line.response;
  const statusCode = response?.status_code ?? 0;
  if (statusCode >= 400) {
    const messageFromObject =
      response?.body && typeof response.body === "object"
        ? (response.body as { error?: { message?: string } }).error?.message
        : undefined;
    const messageFromString = typeof response?.body === "string" ? response.body : undefined;
    params.errors.push(`${customId}: ${messageFromObject ?? messageFromString ?? "unknown error"}`);
    return;
  }

  const data =
    response?.body && typeof response.body === "object" ? (response.body.data ?? []) : [];
  const embedding = data[0]?.embedding ?? [];
  if (embedding.length === 0) {
    params.errors.push(`${customId}: empty embedding`);
    return;
  }
  params.byCustomId.set(customId, embedding);
}
