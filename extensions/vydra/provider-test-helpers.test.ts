import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { vi } from "vitest";

export function stubVydraApiKey(): void {
  vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "vydra-test-key",
    source: "env",
    mode: "api-key",
  });
}

export function jsonResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function binaryResponse(data: string, contentType: string): Response {
  return new Response(Buffer.from(data), {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

export function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
