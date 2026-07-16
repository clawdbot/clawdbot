// Browser tests cover control-client timeoutMs forwarding into fetchWithSsrFGuard.
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  getBridgeAuthForPort: vi.fn(() => undefined),
}));

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const browserControlUrl = "http://127.0.0.1:18791/ok";

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return { ...actual, getRuntimeConfig: authMocks.loadConfig, loadConfig: authMocks.loadConfig };
});
vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: authMocks.resolveBrowserControlAuth,
}));
vi.mock("./bridge-auth-registry.js", () => ({
  getBridgeAuthForPort: authMocks.getBridgeAuthForPort,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

const { fetchBrowserJson } = await import("./client-fetch.js");

describe("fetchBrowserJson timeout forwarding", () => {
  beforeEach(() => fetchWithSsrFGuardMock.mockReset());

  it.each([
    {
      name: "caller-provided timeout",
      init: { timeoutMs: 1_500 },
      expectedTimeoutMs: 1_500,
    },
    {
      name: "default timeout",
      init: undefined,
      expectedTimeoutMs: 5_000,
    },
  ])("forwards the $name to the guarded fetch", async ({ init, expectedTimeoutMs }) => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      finalUrl: browserControlUrl,
      release: async () => {},
    });

    await fetchBrowserJson(browserControlUrl, init);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: browserControlUrl,
        timeoutMs: expectedTimeoutMs,
        signal: expect.any(AbortSignal),
        auditContext: "browser-control-client",
        policy: { allowPrivateNetwork: true },
      }),
    );
  });
});
