// Qa Lab HTTP callers discard response bodies they do not inspect before
// releasing guarded fetch resources. Otherwise the dispatcher must destroy
// the still-streaming connection during release.
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";

export async function discardIgnoredResponseBody(response: Response): Promise<void> {
  if (response.bodyUsed) {
    return;
  }
  await response.body?.cancel().catch(() => undefined);
}

export async function readQaJsonResponse<T>(
  response: Response,
  release: () => Promise<void>,
  label: string,
): Promise<T> {
  try {
    if (!response.ok) {
      await discardIgnoredResponseBody(response);
      throw new Error(`${label} with HTTP ${response.status}.`);
    }
    const limits = { maxBytes: 1 << 20, chunkTimeoutMs: 5_000, timeoutMs: 15_000 };
    return await readProviderJsonResponse<T>(response, label, limits);
  } finally {
    await release();
  }
}
