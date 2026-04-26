import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock, shouldUseEnvHttpProxyForUrlMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  shouldUseEnvHttpProxyForUrlMock: vi.fn(() => false),
}));

vi.mock("../../../../src/infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/infra/net/fetch-guard.js")>(
    "../../../../src/infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

vi.mock("../../../../src/infra/net/proxy-env.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/infra/net/proxy-env.js")>(
    "../../../../src/infra/net/proxy-env.js",
  );
  return {
    ...actual,
    shouldUseEnvHttpProxyForUrl: shouldUseEnvHttpProxyForUrlMock,
  };
});

import { GUARDED_FETCH_MODE } from "../../../../src/infra/net/fetch-guard.js";
import { withRemoteHttpResponse } from "./remote-http.js";

describe("package withRemoteHttpResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(false);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://memory.example/v1",
      release: vi.fn(async () => {}),
    });
  });

  it("uses trusted env proxy mode when the target will use EnvHttpProxyAgent", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      onResponse: async () => undefined,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://memory.example/v1/embeddings",
        mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      }),
    );
  });

  it("keeps strict guarded fetch mode when proxy env would not proxy the target", async () => {
    await withRemoteHttpResponse({
      url: "https://internal.corp.example/v1/embeddings",
      onResponse: async () => undefined,
    });

    const call = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("mode");
  });
});
