import { describe, expect, it, vi } from "vitest";
import { COPILOT_INTEGRATION_ID, buildCopilotIdeHeaders } from "./copilot-dynamic-headers.js";
import {
  deriveCopilotApiBaseUrlFromToken,
  resolveCopilotApiToken,
} from "./github-copilot-token.js";

describe("resolveCopilotApiToken", () => {
  it("derives native Copilot base URLs from Copilot proxy hints", () => {
    expect(
      deriveCopilotApiBaseUrlFromToken(
        "copilot-token;proxy-ep=https://proxy.individual.githubcopilot.com;",
      ),
    ).toBe("https://api.individual.githubcopilot.com");
    expect(deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=proxy.example.com;")).toBe(
      "https://api.example.com",
    );
    expect(deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=proxy.example.com:8443;")).toBe(
      "https://api.example.com",
    );
  });

  it("rejects malformed or non-http proxy hints", () => {
    expect(
      deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=javascript:alert(1);"),
    ).toBeNull();
    expect(deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=://bad;")).toBeNull();
  });

  it("treats 11-digit expires_at values as seconds epochs", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: "copilot-token",
        expires_at: 12_345_678_901,
      }),
    }));

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      cachePath: "/tmp/github-copilot-token-test.json",
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.expiresAt).toBe(12_345_678_901_000);
  });

  it("sends IDE and integration headers when exchanging the GitHub token", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: "copilot-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    }));

    await resolveCopilotApiToken({
      githubToken: "github-token",
      cachePath: "/tmp/github-copilot-token-test.json",
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls.at(0) as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/copilot_internal/v2/token");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer github-token",
      "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
      ...buildCopilotIdeHeaders({ includeApiVersion: true }),
    });
  });

  it("refreshes legacy cached tokens without the vscode-chat integration identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: "fresh-copilot-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    }));
    const saveJsonFileImpl = vi.fn();

    try {
      const result = await resolveCopilotApiToken({
        githubToken: "github-token",
        cachePath: "/tmp/github-copilot-token-test.json",
        loadJsonFileImpl: () => ({
          token: "legacy-copilot-token",
          expiresAt: Date.now() + 60 * 60 * 1000,
          updatedAt: Date.now(),
        }),
        saveJsonFileImpl,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result.token).toBe("fresh-copilot-token");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(saveJsonFileImpl).toHaveBeenCalledWith("/tmp/github-copilot-token-test.json", {
        token: "fresh-copilot-token",
        expiresAt: 1_767_326_645_000,
        updatedAt: 1_767_323_045_000,
        integrationId: COPILOT_INTEGRATION_ID,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
