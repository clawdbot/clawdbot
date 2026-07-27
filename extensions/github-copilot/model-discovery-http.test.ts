import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import {
  COPILOT_MODEL_DISCOVERY_ENDPOINT_SOURCE,
  fetchCopilotModelDiscovery,
} from "./model-discovery-http.js";

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

describe("Copilot model discovery HTTP policy", () => {
  it("trusts token-exchange HTTPS origins through the environment proxy", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: Response.json({ data: [] }),
      finalUrl: "https://api.individual.githubcopilot.com/models",
      release: vi.fn(async () => undefined),
    });

    await fetchCopilotModelDiscovery({
      url: "https://api.individual.githubcopilot.com/models",
      init: { method: "GET" },
      endpointSource: COPILOT_MODEL_DISCOVERY_ENDPOINT_SOURCE.TOKEN_EXCHANGE,
      timeoutMs: 10_000,
      auditContext: "github-copilot.model-discovery-test",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
        requireHttps: true,
        maxRedirects: 0,
        policy: {
          allowedOrigins: ["https://api.individual.githubcopilot.com"],
        },
      }),
    );
  });

  it("keeps operator overrides on strict guarded routing", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: Response.json({ data: [] }),
      finalUrl: "https://copilot-proxy.example/models",
      release: vi.fn(async () => undefined),
    });

    await fetchCopilotModelDiscovery({
      url: "https://copilot-proxy.example/models",
      init: { method: "GET" },
      endpointSource: COPILOT_MODEL_DISCOVERY_ENDPOINT_SOURCE.OPERATOR_OVERRIDE,
      policy: { allowedHostnames: ["copilot-proxy.example"] },
      timeoutMs: 10_000,
      auditContext: "github-copilot.model-discovery-test",
    });

    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      policy: { allowedHostnames: ["copilot-proxy.example"] },
      url: "https://copilot-proxy.example/models",
    });
    expect(request).not.toHaveProperty("mode");
    expect(request).not.toHaveProperty("requireHttps");
  });
});
