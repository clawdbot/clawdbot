import { describe, expect, it } from "vitest";
import { GUARDED_FETCH_MODE } from "../../infra/net/fetch-guard.js";
import { withRemoteHttpResponse } from "./remote-http.js";

describe("withRemoteHttpResponse", () => {
  function makeFetchDeps({ useEnvProxy = false }: { useEnvProxy?: boolean } = {}) {
    const calls: unknown[] = [];
    return {
      calls,
      fetchWithSsrFGuardImpl: async (params: unknown) => {
        calls.push(params);
        return {
          response: new Response("ok", { status: 200 }),
          finalUrl: "https://memory.example/v1",
          release: async () => {},
        };
      },
      shouldUseEnvHttpProxyForUrlImpl: () => useEnvProxy,
    };
  }

  it("uses trusted env proxy mode when the target will use EnvHttpProxyAgent", async () => {
    const deps = makeFetchDeps({ useEnvProxy: true });

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls[0]).toEqual(
      expect.objectContaining({
        url: "https://memory.example/v1/embeddings",
        mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      }),
    );
  });

  it("keeps strict guarded fetch mode when proxy env would not proxy the target", async () => {
    const deps = makeFetchDeps();

    await withRemoteHttpResponse({
      url: "https://internal.corp.example/v1/embeddings",
      onResponse: async () => undefined,
      ...deps,
    });

    expect(deps.calls[0]).toBeDefined();
    expect(deps.calls[0]).not.toHaveProperty("mode");
  });
});
