import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { fetchOllamaModels, queryOllamaModelShowInfo } from "./provider-models.js";

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

describe("Ollama model discovery proxy policy", () => {
  it("uses trusted environment proxies for hosted catalog requests", async () => {
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }) => ({
      response: url.endsWith("/api/tags")
        ? Response.json({ models: [] })
        : Response.json({ model_info: {} }),
      finalUrl: url,
      release: async () => undefined,
    }));

    await fetchOllamaModels("https://ollama.com");
    await queryOllamaModelShowInfo("https://ollama.com", "cloud-model");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    const tagsRequest = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(tagsRequest).toMatchObject({
      mode: "trusted_env_proxy",
      requireHttps: true,
      policy: { hostnameAllowlist: ["ollama.com"], allowPrivateNetwork: true },
    });
    const showRequest = fetchWithSsrFGuardMock.mock.calls[1]?.[0];
    expect(showRequest).toMatchObject({
      mode: "trusted_env_proxy",
      requireHttps: true,
      maxRedirects: 0,
      policy: { allowedOrigins: ["https://ollama.com"] },
    });
  });

  it("keeps local and custom Ollama discovery strict", async () => {
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }) => ({
      response: Response.json({ models: [] }),
      finalUrl: url,
      release: async () => undefined,
    }));

    await fetchOllamaModels("http://127.0.0.1:11434");
    await fetchOllamaModels("https://ollama.example.com");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    for (const [request] of fetchWithSsrFGuardMock.mock.calls) {
      expect(request).not.toHaveProperty("mode");
    }
  });
});
