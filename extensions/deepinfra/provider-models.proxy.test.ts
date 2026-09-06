// DeepInfra proxy tests cover both public transports and their resource ownership.
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { discoverDeepInfraModels } from "./provider-models.js";

afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

describe("DeepInfra model discovery proxy policy", () => {
  it.each(["success", "malformed", "unavailable"])(
    "pairs both anonymous guarded requests with release on %s",
    async (scenario) => {
      const releases: ReturnType<typeof vi.fn>[] = [];
      fetchWithSsrFGuardMock.mockImplementation(async ({ url }) => {
        const release = vi.fn(async () => undefined);
        releases.push(release);
        const body = url.endsWith("/models/list")
          ? [
              {
                model_name: "fixture/chat",
                pricing: {
                  type: "tokens",
                  cents_per_input_token: 0.0002,
                  cents_per_output_token: 0.001,
                },
              },
            ]
          : { data: [{ id: "fixture/chat", metadata: { tags: ["chat"] } }] };
        return {
          finalUrl: url,
          response:
            scenario === "unavailable"
              ? new Response("unavailable", { status: 503 })
              : scenario === "malformed"
                ? new Response("not JSON")
                : Response.json(body),
          release,
        };
      });
      const acquisition = discoverDeepInfraModels({ hasApiKey: true, env: {} });
      if (scenario === "success") {
        await expect(acquisition).resolves.toMatchObject([{ id: "fixture/chat" }]);
      } else {
        await expect(acquisition).rejects.toThrow();
      }
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
      expect(new Set(fetchWithSsrFGuardMock.mock.calls.map(([request]) => request.url))).toEqual(
        new Set([
          "https://api.deepinfra.com/models/list",
          "https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta",
        ]),
      );
      for (const [request] of fetchWithSsrFGuardMock.mock.calls) {
        expect(request.mode).toBe("trusted_env_proxy");
        expect(new Headers(request.init.headers).has("authorization")).toBe(false);
        expect(request.timeoutMs).toBeLessThanOrEqual(5000);
      }
      expect(releases).toHaveLength(2);
      for (const release of releases) {
        expect(release).toHaveBeenCalledOnce();
      }
    },
  );
});
