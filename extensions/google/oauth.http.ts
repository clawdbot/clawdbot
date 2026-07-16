import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { DEFAULT_FETCH_TIMEOUT_MS } from "./oauth.shared.js";

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init,
    timeoutMs,
  });
  try {
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await release();
  }
}
