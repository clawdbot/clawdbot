import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexProviderWebSearchSupport } from "./provider-capabilities.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";

const appServer = {
  start: {},
  requestTimeoutMs: 1_000,
} as CodexAppServerRuntimeOptions;

function createClientFactory(webSearch: boolean | boolean[]) {
  const values = Array.isArray(webSearch) ? [...webSearch] : [webSearch];
  const request = vi.fn(async () => ({ webSearch: values.shift() ?? false }));
  const client = { request } as unknown as CodexAppServerClient;
  const clientFactory = vi.fn(async () => client) as unknown as CodexAppServerClientFactory;
  return { clientFactory, request };
}

function resolveSupport(
  clientFactory: CodexAppServerClientFactory,
  modelProviderOverride?: string,
) {
  return resolveCodexProviderWebSearchSupport({
    clientFactory,
    appServer,
    authProfileId: undefined,
    agentDir: "/tmp/agent",
    config: undefined,
    modelProviderOverride,
    signal: new AbortController().signal,
  });
}

describe("resolveCodexProviderWebSearchSupport", () => {
  it("reads the latest configured provider capability for each attempt", async () => {
    const { clientFactory, request } = createClientFactory([true, false]);

    await expect(resolveSupport(clientFactory)).resolves.toBe("supported");
    await expect(resolveSupport(clientFactory)).resolves.toBe("unsupported");

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      "modelProvider/capabilities/read",
      {},
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
  });

  it("forwards one prepared auth handoff to capability startup", async () => {
    const { clientFactory } = createClientFactory(true);
    const preparedAuth = {
      kind: "api-key" as const,
      apiKey: "prepared-platform-key",
    };

    await expect(
      resolveCodexProviderWebSearchSupport({
        clientFactory,
        appServer,
        authProfileId: "openai:decoy",
        preparedAuth,
        agentDir: "/tmp/agent",
        config: undefined,
        modelProviderOverride: undefined,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("supported");

    expect(clientFactory).toHaveBeenCalledWith(expect.objectContaining({ preparedAuth }));
    const factoryCalls = (
      clientFactory as unknown as {
        mock: { calls: Array<[{ preparedAuth?: unknown }]> };
      }
    ).mock.calls;
    expect(factoryCalls[0]?.[0].preparedAuth).toBe(preparedAuth);
    expect(clientFactory).not.toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: expect.anything() }),
    );
  });

  it("forwards the exact prepared profile snapshot to capability startup", async () => {
    const { clientFactory } = createClientFactory(true);
    const preparedAuth = {
      kind: "profile" as const,
      profileId: "openai:work",
      store: {
        version: 1 as const,
        profiles: {
          "openai:work": {
            type: "token" as const,
            provider: "openai",
            token: "prepared-token",
          },
        },
      },
      snapshot: {
        loginParams: {
          type: "chatgptAuthTokens" as const,
          accessToken: "prepared-token",
          chatgptAccountId: "prepared-account",
          chatgptPlanType: null,
        },
        secretFreeCacheKey: "prepared-account:token:sha256:opaque",
      },
    };

    await expect(
      resolveCodexProviderWebSearchSupport({
        clientFactory,
        appServer,
        authProfileId: undefined,
        preparedAuth,
        agentDir: "/tmp/agent",
        config: undefined,
        modelProviderOverride: undefined,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("supported");

    const factoryCalls = (
      clientFactory as unknown as {
        mock: { calls: Array<[{ preparedAuth?: unknown }]> };
      }
    ).mock.calls;
    expect(factoryCalls[0]?.[0].preparedAuth).toBe(preparedAuth);
  });

  it("reports unknown support when app-server startup fails", async () => {
    const clientFactory = vi.fn(async () => {
      throw new Error("old app-server");
    }) as unknown as CodexAppServerClientFactory;

    await expect(resolveSupport(clientFactory)).resolves.toBe("unknown");
  });

  it("reports unknown support when the capability read fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("transient rpc failure");
    });
    const client = { request } as unknown as CodexAppServerClient;
    const clientFactory = vi.fn(async () => client) as unknown as CodexAppServerClientFactory;

    await expect(resolveSupport(clientFactory)).resolves.toBe("unknown");
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps managed search when the configured provider reports no hosted support", async () => {
    const { clientFactory, request } = createClientFactory(false);

    await expect(resolveSupport(clientFactory)).resolves.toBe("unsupported");
    expect(request).toHaveBeenCalledOnce();
  });

  it("uses hosted search for the built-in OpenAI provider override", async () => {
    const { clientFactory, request } = createClientFactory(false);

    await expect(resolveSupport(clientFactory, " OpenAI ")).resolves.toBe("supported");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps managed search for provider overrides the capability RPC cannot target", async () => {
    const { clientFactory, request } = createClientFactory(true);

    await expect(resolveSupport(clientFactory, "amazon-bedrock")).resolves.toBe("unsupported");
    await expect(resolveSupport(clientFactory, "custom-provider")).resolves.toBe("unsupported");
    await expect(resolveSupport(clientFactory, "lmstudio")).resolves.toBe("unsupported");
    expect(request).not.toHaveBeenCalled();
  });
});
