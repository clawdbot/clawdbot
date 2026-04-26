import {
  buildBatchHeaders,
  normalizeBatchBaseUrl,
  type BatchHttpClientConfig,
} from "./batch-utils.js";
import { hashText } from "./hash.js";
import { withRemoteHttpResponse } from "./remote-http.js";

export async function uploadBatchJsonlFile(params: {
  client: BatchHttpClientConfig;
  requests: unknown[];
  errorPrefix: string;
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
    fetchImpl: params.client.fetchImpl,
    init: {
      method: "POST",
      headers: buildBatchHeaders(params.client, { json: false }),
      body: form,
    },
    onResponse: async (fileRes) => {
      if (!fileRes.ok) {
        const text = await fileRes.text();
        throw new Error(`${params.errorPrefix}: ${fileRes.status} ${text}`);
      }
      return (await fileRes.json()) as { id?: string };
    },
  });
  if (!filePayload.id) {
    throw new Error(`${params.errorPrefix}: missing file id`);
  }
  return filePayload.id;
}
