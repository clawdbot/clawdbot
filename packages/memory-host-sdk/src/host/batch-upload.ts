// Memory Host SDK module implements batch upload behavior.
import {
  buildBatchHeaders,
  normalizeBatchBaseUrl,
  type BatchHttpClientConfig,
} from "./batch-utils.js";
import { hashText } from "./hash.js";
import { withRemoteHttpResponse } from "./remote-http.js";
import { readResponseJsonWithLimit, readResponseTextSnippet } from "./response-snippet.js";

// Uploads provider batch JSONL payloads through the shared remote HTTP guard.

/** Upload embedding batch requests and return the provider file id. */
export async function uploadBatchJsonlFile(params: {
  client: BatchHttpClientConfig;
  requests: unknown[];
  errorPrefix: string;
  maxResponseBytes?: number;
}): Promise<string> {
  const baseUrl = normalizeBatchBaseUrl(params.client);
  const jsonl = params.requests.map((request) => JSON.stringify(request)).join("\n");
  const form = new FormData();
  form.append("purpose", "batch");
  form.append(
    "file",
    new Blob([jsonl], { type: "application/jsonl" }),
    `memory-embeddings.${hashText(String(Date.now()))}.jsonl`,
  );

  const filePayload = await withRemoteHttpResponse({
    url: `${baseUrl}/files`,
    ssrfPolicy: params.client.ssrfPolicy,
    init: {
      method: "POST",
      headers: buildBatchHeaders(params.client, { json: false }),
      body: form,
    },
    onResponse: async (fileRes) => {
      if (!fileRes.ok) {
        const text = await readResponseTextSnippet(fileRes);
        throw new Error(`${params.errorPrefix}: ${fileRes.status} ${text}`);
      }
      return (await readResponseJsonWithLimit(fileRes, {
        errorPrefix: params.errorPrefix,
        maxBytes: params.maxResponseBytes,
      })) as { id?: string };
    },
  });
  if (!filePayload.id) {
    throw new Error(`${params.errorPrefix}: missing file id`);
  }
  return filePayload.id;
}
