// Microsoft Foundry tests cover index plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { azLoginDeviceCodeWithOptions, getAccessTokenResultAsync } from "./cli.js";
import plugin from "./index.js";
import {
  promptApiKeyEndpointAndModel,
  promptEndpointAndModelManually,
  selectFoundryDeployment,
} from "./onboard.js";
import {
  COGNITIVE_SERVICES_RESOURCE,
  FOUNDRY_ANTHROPIC_SCOPE,
  buildFoundryAuthResult,
  extractFoundryEndpoint,
  formatFoundryApiLabel,
  isFoundryMaiImageModel,
  normalizeFoundryEndpoint,
  requiresFoundryMaxCompletionTokens,
  requiresFoundryEntraIdClaudeAuth,
  usesFoundryResponsesByDefault,
} from "./shared.js";
import { microsoftFoundryTesting } from "./test-support.js";

const {
  buildFoundryConnectionTest,
  isAnthropicFoundryDeployment,
  isValidTenantIdentifier,
  resetFoundryRuntimeAuthCaches,
  shouldTestFoundryTextConnection,
  supportsFoundryImageInput,
  supportsFoundryReasoningContent,
  supportsFoundryReasoningEffort,
} = microsoftFoundryTesting;

const execFileMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const ensureAuthProfileStoreMock = vi.hoisted(() =>
  vi.fn(() => ({
    profiles: {},
  })),
);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
    spawn: spawnMock,
  };
});

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    runExec: execFileMock,
  };
});

vi.mock("openclaw/plugin-sdk/provider-auth", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-auth")>(
    "openclaw/plugin-sdk/provider-auth",
  );
  return {
    ...actual,
    ensureAuthProfileStore: ensureAuthProfileStoreMock,
  };
});

function registerProvider() {
  const registerProviderMock = vi.fn();
  plugin.register(
    createTestPluginApi({
      id: "microsoft-foundry",
      name: "Microsoft Foundry",
      source: "test",
      config: {},
      runtime: {} as never,
      registerProvider: registerProviderMock,
    }),
  );
  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  const firstCall = registerProviderMock.mock.calls[0];
  if (!firstCall) {
    throw new Error("expected Microsoft Foundry provider registration");
  }
  return firstCall[0];
}

type FoundryProvider = ReturnType<typeof registerProvider>;

function requirePrepareRuntimeAuth(
  provider: FoundryProvider,
): NonNullable<FoundryProvider["prepareRuntimeAuth"]> {
  const prepareRuntimeAuth = provider.prepareRuntimeAuth;
  expect(prepareRuntimeAuth).toBeTypeOf("function");
  if (!prepareRuntimeAuth) {
    throw new Error("expected Microsoft Foundry runtime auth hook");
  }
  return prepareRuntimeAuth;
}

function requireRuntimeAuthResult(
  result:
    | {
        apiKey?: string;
        baseUrl?: string;
        expiresAt?: number;
        request?: {
          auth?:
            | { mode: "authorization-bearer"; token: string }
            | { mode: "header"; headerName: string; value: string };
        };
      }
    | undefined,
) {
  if (!result) {
    throw new Error("expected Microsoft Foundry runtime auth result");
  }
  return result;
}

function requireFoundryProviderPatch(result: ReturnType<typeof buildFoundryAuthResult>) {
  const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
  if (!provider) {
    throw new Error("expected Microsoft Foundry provider config patch");
  }
  return provider;
}

const defaultFoundryBaseUrl = "https://example.services.ai.azure.com/openai/v1";
const defaultFoundryProviderId = "microsoft-foundry";
const defaultFoundryModelId = "gpt-5.4";
const defaultFoundryProfileId = "microsoft-foundry:entra";
const defaultFoundryAgentDir = "/tmp/test-agent";
const defaultAzureCliLoginError = "Please run 'az login' to setup account.";

function buildFoundryModel(
  overrides: Partial<{
    provider: string;
    id: string;
    name: string;
    api: "openai-responses" | "openai-completions" | "anthropic-messages";
    baseUrl: string;
    reasoning: boolean;
    input: Array<"text" | "image">;
    compat: Record<string, unknown>;
  }> = {},
) {
  return {
    provider: defaultFoundryProviderId,
    id: defaultFoundryModelId,
    name: defaultFoundryModelId,
    api: "openai-responses" as const,
    baseUrl: defaultFoundryBaseUrl,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  };
}

function buildFoundryConfig(params?: {
  profileIds?: string[];
  orderedProfileIds?: string[];
  models?: ReturnType<typeof buildFoundryModel>[];
}) {
  const profileIds = params?.profileIds ?? [];
  const orderedProfileIds = params?.orderedProfileIds;
  return {
    auth: {
      profiles: Object.fromEntries(
        profileIds.map((profileId) => [
          profileId,
          {
            provider: defaultFoundryProviderId,
            mode: "api_key" as const,
          },
        ]),
      ),
      ...(orderedProfileIds
        ? {
            order: {
              [defaultFoundryProviderId]: orderedProfileIds,
            },
          }
        : {}),
    },
    models: {
      providers: {
        [defaultFoundryProviderId]: {
          baseUrl: defaultFoundryBaseUrl,
          api: "openai-responses" as const,
          models: params?.models ?? [buildFoundryModel()],
        },
      },
    },
  } satisfies OpenClawConfig;
}

function buildEntraProfileStore(
  overrides: Partial<{
    api: "openai-responses" | "openai-completions" | "anthropic-messages";
    endpoint: string;
    modelId: string;
    modelName: string;
    tenantId: string;
  }> = {},
) {
  return {
    profiles: {
      [defaultFoundryProfileId]: {
        type: "api_key",
        provider: defaultFoundryProviderId,
        metadata: {
          authMethod: "entra-id",
          endpoint: "https://example.services.ai.azure.com",
          modelId: "custom-deployment",
          modelName: defaultFoundryModelId,
          api: "openai-responses",
          tenantId: "tenant-id",
          ...overrides,
        },
      },
    },
  };
}

function buildFoundryRuntimeAuthContext(
  overrides: Partial<{
    provider: string;
    modelId: string;
    model: ReturnType<typeof buildFoundryModel>;
    apiKey: string;
    authMode: "api_key";
    profileId: string;
    agentDir: string;
  }> = {},
) {
  const modelId = overrides.modelId ?? "custom-deployment";
  return {
    provider: defaultFoundryProviderId,
    modelId,
    model: buildFoundryModel({ id: modelId, ...("model" in overrides ? overrides.model : {}) }),
    apiKey: "__entra_id_dynamic__",
    authMode: "api_key" as const,
    profileId: defaultFoundryProfileId,
    env: process.env,
    agentDir: defaultFoundryAgentDir,
    ...overrides,
  };
}

function mockAzureCliToken(params: { accessToken: string; expiresInMs: number; delayMs?: number }) {
  execFileMock.mockImplementationOnce(async () => {
    if (params.delayMs) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, params.delayMs);
      });
    }
    return {
      stdout: JSON.stringify({
        accessToken: params.accessToken,
        expiresOn: new Date(Date.now() + params.expiresInMs).toISOString(),
      }),
      stderr: "",
    };
  });
}

function mockAzureCliTokenRaw(stdout: string) {
  execFileMock.mockResolvedValueOnce({ stdout, stderr: "" });
}

function mockAzureCliLoginFailure(delayMs?: number) {
  execFileMock.mockImplementationOnce(async () => {
    if (delayMs) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
    throw Object.assign(new Error("az failed"), { stderr: defaultAzureCliLoginError, stdout: "" });
  });
}

describe("microsoft-foundry plugin", () => {
  beforeEach(() => {
    resetFoundryRuntimeAuthCaches();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    ensureAuthProfileStoreMock.mockReset();
    ensureAuthProfileStoreMock.mockReturnValue({ profiles: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the API key profile bound when multiple auth profiles exist without explicit order", async () => {
    const provider = registerProvider();
    const config = buildFoundryConfig({
      profileIds: ["microsoft-foundry:default", "microsoft-foundry:entra"],
    });

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/gpt-5.4",
      prompter: {} as never,
      agentDir: "/tmp/test-agent",
    });

    expect(config.auth?.order?.["microsoft-foundry"]).toBeUndefined();
  });

  it("uses the active ordered API key profile when model selection rebinding is needed", async () => {
    const provider = registerProvider();
    ensureAuthProfileStoreMock.mockReturnValueOnce({
      profiles: {
        "microsoft-foundry:default": {
          type: "api_key",
          provider: "microsoft-foundry",
          metadata: { authMethod: "api-key" },
        },
      },
    });
    const config = buildFoundryConfig({
      profileIds: ["microsoft-foundry:default"],
      orderedProfileIds: ["microsoft-foundry:default"],
    });

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/gpt-5.4",
      prompter: {} as never,
      agentDir: "/tmp/test-agent",
    });

    expect(config.auth?.order?.["microsoft-foundry"]).toEqual(["microsoft-foundry:default"]);
  });

  it("tolerates timeout-only provider overlays when selecting a Foundry model", async () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "",
            models: [],
            timeoutSeconds: 120,
          },
        },
      },
    } as unknown as OpenClawConfig;

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/gpt-5.4",
      prompter: {} as never,
      agentDir: defaultFoundryAgentDir,
    });

    expect(config.models?.providers?.["microsoft-foundry"]?.models).toEqual([]);
    expect(config.models?.providers?.["microsoft-foundry"]?.timeoutSeconds).toBe(120);
  });

  it("reports malformed Azure CLI token JSON with an owned error", async () => {
    mockAzureCliTokenRaw("{not json");

    await expect(getAccessTokenResultAsync()).rejects.toThrow(
      "Azure CLI returned malformed access token JSON.",
    );
  });

  it("requests scoped Azure CLI tokens for Foundry Anthropic probes", async () => {
    mockAzureCliTokenRaw(JSON.stringify({ accessToken: "scoped-token" }));

    await getAccessTokenResultAsync({ scope: FOUNDRY_ANTHROPIC_SCOPE });

    expect(execFileMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["--scope", FOUNDRY_ANTHROPIC_SCOPE]),
    );
  });

  it("fails clearly when the selected Azure subscription is not in the enabled list", async () => {
    const provider = registerProvider();
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      const command = args.join(" ");
      if (command === "version --output none") {
        return "";
      }
      if (command === "account show --output json") {
        return JSON.stringify({
          id: "sub-one",
          name: "Subscription One",
          tenantId: "tenant-one",
          state: "Enabled",
          user: { name: "user@example.com" },
        });
      }
      if (command === "account list --output json --all") {
        return JSON.stringify([
          {
            id: "sub-one",
            name: "Subscription One",
            tenantId: "tenant-one",
            state: "Enabled",
          },
          {
            id: "sub-two",
            name: "Subscription Two",
            tenantId: "tenant-one",
            state: "Enabled",
          },
        ]);
      }
      throw new Error(`unexpected az command: ${command}`);
    });
    const entraAuth = provider.auth.find((method: { id: string }) => method.id === "entra-id");

    await expect(
      entraAuth?.run({
        config: {},
        agentDir: defaultFoundryAgentDir,
        opts: {},
        prompter: {
          confirm: vi.fn(async () => true),
          select: vi.fn(async () => "missing-subscription"),
          note: vi.fn(async () => undefined),
        },
      } as never),
    ).rejects.toThrow("Selected subscription not found: missing-subscription");
  });

  it("preserves the model-derived base URL for Entra runtime auth refresh", async () => {
    const provider = registerProvider();
    const prepareRuntimeAuth = requirePrepareRuntimeAuth(provider);
    mockAzureCliToken({ accessToken: "test-token-placeholder", expiresInMs: 60_000 });
    ensureAuthProfileStoreMock.mockReturnValueOnce(buildEntraProfileStore());

    const prepared = requireRuntimeAuthResult(
      await prepareRuntimeAuth(buildFoundryRuntimeAuthContext()),
    );

    expect(prepared.baseUrl).toBe("https://example.services.ai.azure.com/openai/v1");
    expect(prepared.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "test-token-placeholder",
    });
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["--resource", COGNITIVE_SERVICES_RESOURCE]),
    );
  });

  it("falls back to Entra metadata when a configured Foundry endpoint is malformed", async () => {
    const provider = registerProvider();
    const prepareRuntimeAuth = requirePrepareRuntimeAuth(provider);
    mockAzureCliToken({ accessToken: "test-token-placeholder", expiresInMs: 60_000 });
    ensureAuthProfileStoreMock.mockReturnValueOnce(buildEntraProfileStore());

    const prepared = requireRuntimeAuthResult(
      await prepareRuntimeAuth(
        buildFoundryRuntimeAuthContext({
          model: buildFoundryModel({ baseUrl: "not a url" }),
        }),
      ),
    );

    expect(extractFoundryEndpoint("not a url")).toBeUndefined();
    expect(prepared.baseUrl).toBe("https://example.services.ai.azure.com/openai/v1");
    expect(prepared.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "test-token-placeholder",
    });
  });

  it.each([
    ["openai-responses", "api-key"],
    ["anthropic-messages", "x-api-key"],
  ] as const)("binds %s API-key auth to the active profile", async (api, headerName) => {
    const provider = registerProvider();
    const prepareRuntimeAuth = requirePrepareRuntimeAuth(provider);

    const prepared = requireRuntimeAuthResult(
      await prepareRuntimeAuth(
        buildFoundryRuntimeAuthContext({
          apiKey: "profile-api-key",
          profileId: "microsoft-foundry:default",
          model: buildFoundryModel({ api }),
        }),
      ),
    );

    expect(prepared).toEqual({
      apiKey: "profile-api-key",
      request: {
        auth: { mode: "header", headerName, value: "profile-api-key" },
      },
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("uses active model routing when Entra metadata points at another deployment", async () => {
    const provider = registerProvider();
    const prepareRuntimeAuth = requirePrepareRuntimeAuth(provider);
    mockAzureCliToken({ accessToken: "test-token-placeholder", expiresInMs: 60_000 });
    ensureAuthProfileStoreMock.mockReturnValueOnce(
      buildEntraProfileStore({
        endpoint: "https://example.services.ai.azure.com",
        modelId: "deployment-gpt5",
        modelName: "gpt-5.4",
        api: "openai-responses",
      }),
    );

    const prepared = requireRuntimeAuthResult(
      await prepareRuntimeAuth(
        buildFoundryRuntimeAuthContext({
          modelId: "deployment-fable",
          model: buildFoundryModel({
            id: "deployment-fable",
            name: "claude-fable-5",
            api: "anthropic-messages",
            baseUrl: "https://example.services.ai.azure.com/anthropic",
          }),
        }),
      ),
    );

    expect(prepared.baseUrl).toBe("https://example.services.ai.azure.com/anthropic");
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["--scope", FOUNDRY_ANTHROPIC_SCOPE]),
    );
  });

  it("does not reuse OpenAI Entra tokens for Anthropic Foundry deployments", async () => {
    const provider = registerProvider();
    const prepareRuntimeAuth = requirePrepareRuntimeAuth(provider);
    mockAzureCliToken({ accessToken: "gpt-token", expiresInMs: 60_000 });
    mockAzureCliToken({ accessToken: "claude-token", expiresInMs: 60_000 });
    ensureAuthProfileStoreMock.mockReturnValue(
      buildEntraProfileStore({
        endpoint: "https://example.services.ai.azure.com",
        modelId: "deployment-gpt5",
        modelName: "gpt-5.4",
        api: "openai-responses",
      }),
    );

    const gptPrepared = requireRuntimeAuthResult(
      await prepareRuntimeAuth(
        buildFoundryRuntimeAuthContext({
          modelId: "deployment-gpt5",
          model: buildFoundryModel({
            id: "deployment-gpt5",
            name: "gpt-5.4",
            api: "openai-responses",
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
          }),
        }),
      ),
    );
    const claudePrepared = requireRuntimeAuthResult(
      await prepareRuntimeAuth(
        buildFoundryRuntimeAuthContext({
          modelId: "deployment-fable",
          model: buildFoundryModel({
            id: "deployment-fable",
            name: "claude-fable-5",
            api: "anthropic-messages",
            baseUrl: "https://example.services.ai.azure.com/anthropic",
          }),
        }),
      ),
    );

    expect(gptPrepared.apiKey).toBe("gpt-token");
    expect(claudePrepared.apiKey).toBe("claude-token");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["--resource", COGNITIVE_SERVICES_RESOURCE]),
    );
    expect(execFileMock.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["--scope", FOUNDRY_ANTHROPIC_SCOPE]),
    );
  });

  it("retries Entra token refresh after a failed attempt", async () => {
    const provider = registerProvider();
    const prepareRuntimeAuth = requirePrepareRuntimeAuth(provider);
    mockAzureCliLoginFailure();
    mockAzureCliToken({ accessToken: "retry-token", expiresInMs: 10 * 60_000 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const runtimeContext = buildFoundryRuntimeAuthContext();

    await expect(prepareRuntimeAuth(runtimeContext)).rejects.toThrow("Azure CLI is not logged in");

    const prepared = requireRuntimeAuthResult(await prepareRuntimeAuth(runtimeContext));
    expect(prepared.apiKey).toBe("retry-token");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent Entra token refreshes for the same profile", async () => {
    const provider = registerProvider();
    const prepareRuntimeAuth = requirePrepareRuntimeAuth(provider);
    mockAzureCliToken({ accessToken: "deduped-token", expiresInMs: 60_000, delayMs: 10 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const runtimeContext = buildFoundryRuntimeAuthContext();

    const [first, second] = await Promise.all([
      prepareRuntimeAuth(runtimeContext),
      prepareRuntimeAuth(runtimeContext),
    ]);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(requireRuntimeAuthResult(first).apiKey).toBe("deduped-token");
    expect(requireRuntimeAuthResult(second).apiKey).toBe("deduped-token");
  });

  it("clears failed refresh state so later concurrent retries succeed", async () => {
    const provider = registerProvider();
    const prepareRuntimeAuth = requirePrepareRuntimeAuth(provider);
    mockAzureCliLoginFailure(10);
    mockAzureCliToken({ accessToken: "recovered-token", expiresInMs: 10 * 60_000, delayMs: 10 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const runtimeContext = buildFoundryRuntimeAuthContext();

    const failed = await Promise.allSettled([
      prepareRuntimeAuth(runtimeContext),
      prepareRuntimeAuth(runtimeContext),
    ]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const [first, second] = await Promise.all([
      prepareRuntimeAuth(runtimeContext),
      prepareRuntimeAuth(runtimeContext),
    ]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(requireRuntimeAuthResult(first).apiKey).toBe("recovered-token");
    expect(requireRuntimeAuthResult(second).apiKey).toBe("recovered-token");
  });

  it("refreshes again when a cached token is too close to expiry", async () => {
    const provider = registerProvider();
    mockAzureCliToken({ accessToken: "soon-expiring-token", expiresInMs: 60_000 });
    mockAzureCliToken({ accessToken: "fresh-token", expiresInMs: 10 * 60_000 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const runtimeContext = buildFoundryRuntimeAuthContext();

    const first = requireRuntimeAuthResult(await provider.prepareRuntimeAuth?.(runtimeContext));
    expect(first.apiKey).toBe("soon-expiring-token");
    const second = requireRuntimeAuthResult(await provider.prepareRuntimeAuth?.(runtimeContext));
    expect(second.apiKey).toBe("fresh-token");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("bounds Entra token fallback expiry when the process clock is invalid", async () => {
    const provider = registerProvider();
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    mockAzureCliTokenRaw(JSON.stringify({ accessToken: "fallback-token" }));
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const prepared = requireRuntimeAuthResult(
      await provider.prepareRuntimeAuth?.(buildFoundryRuntimeAuthContext()),
    );

    expect(prepared.apiKey).toBe("fallback-token");
    expect(prepared.expiresAt).toBe(55 * 60 * 1000);
  });

  it("treats an invalid process clock as an Entra token cache miss", async () => {
    const provider = registerProvider();
    mockAzureCliToken({ accessToken: "cached-token", expiresInMs: 10 * 60_000 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());
    const runtimeContext = buildFoundryRuntimeAuthContext();

    const first = requireRuntimeAuthResult(await provider.prepareRuntimeAuth?.(runtimeContext));
    expect(first.apiKey).toBe("cached-token");

    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    mockAzureCliTokenRaw(
      JSON.stringify({
        accessToken: "refreshed-token",
        expiresOn: "2026-05-29T12:10:00.000Z",
      }),
    );
    const second = requireRuntimeAuthResult(await provider.prepareRuntimeAuth?.(runtimeContext));

    expect(second.apiKey).toBe("refreshed-token");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("keeps other configured Foundry models when switching the selected model", async () => {
    const provider = registerProvider();
    const config: OpenClawConfig = {
      auth: {
        profiles: {
          "microsoft-foundry:default": {
            provider: "microsoft-foundry",
            mode: "api_key" as const,
          },
        },
        order: {
          "microsoft-foundry": ["microsoft-foundry:default"],
        },
      },
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            api: "openai-responses",
            models: [
              {
                id: "alias-one",
                name: "gpt-5.4",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
              {
                id: "alias-two",
                name: "gpt-4o",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    };

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/alias-one",
      prompter: {} as never,
      agentDir: "/tmp/test-agent",
    });

    expect(
      config.models?.providers?.["microsoft-foundry"]?.models.map((model) => model.id),
    ).toEqual(["alias-one", "alias-two"]);
    expect(config.models?.providers?.["microsoft-foundry"]?.models[0]?.input).toEqual([
      "text",
      "image",
    ]);
  });

  it("preserves an explicit per-model Foundry endpoint when switching models", async () => {
    const provider = registerProvider();
    const config = buildFoundryConfig({
      models: [
        buildFoundryModel({
          id: "prod-fable",
          name: "claude-fable-5",
          api: "anthropic-messages",
          baseUrl: "https://claude-resource.services.ai.azure.com/anthropic",
          reasoning: true,
          input: ["text", "image"],
        }),
      ],
    });

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/prod-fable",
      prompter: {} as never,
      agentDir: "/tmp/test-agent",
    });

    const providerConfig = config.models?.providers?.["microsoft-foundry"];
    expect(providerConfig?.baseUrl).toBe("https://claude-resource.services.ai.azure.com/anthropic");
    expect(providerConfig?.models[0]?.baseUrl).toBe(
      "https://claude-resource.services.ai.azure.com/anthropic",
    );
  });

  it("marks newly selected Foundry reasoning deployments as reasoning-capable", async () => {
    const provider = registerProvider();
    const config = buildFoundryConfig({ models: [] });

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/gpt-5.4",
      prompter: {} as never,
      agentDir: "/tmp/test-agent",
    });

    const model = config.models?.providers?.["microsoft-foundry"]?.models[0];
    expect(model?.id).toBe("gpt-5.4");
    expect(model?.reasoning).toBe(true);
    expect(model?.compat?.supportsReasoningEffort).toBe(true);
  });

  it("preserves Fable limits when adding a newly selected Foundry deployment", async () => {
    const provider = registerProvider();
    const config = buildFoundryConfig({ models: [] });

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/claude-fable-5",
      prompter: {} as never,
      agentDir: "/tmp/test-agent",
    });

    const model = config.models?.providers?.["microsoft-foundry"]?.models[0];
    expect(model?.id).toBe("claude-fable-5");
    expect(model?.api).toBe("anthropic-messages");
    expect(model?.baseUrl).toBe("https://example.services.ai.azure.com/anthropic");
    expect(model?.contextWindow).toBe(1_000_000);
    expect(model?.maxTokens).toBe(128_000);
    expect(config.models?.providers?.["microsoft-foundry"]?.api).toBe("anthropic-messages");
    expect(config.models?.providers?.["microsoft-foundry"]?.baseUrl).toBe(
      "https://example.services.ai.azure.com/anthropic",
    );
  });

  it("infers OpenAI routing when adding a GPT deployment from a Claude-configured provider", async () => {
    const provider = registerProvider();
    const config: OpenClawConfig = {
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/anthropic",
            api: "anthropic-messages",
            models: [],
          },
        },
      },
    };

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/gpt-5.4",
      prompter: {} as never,
      agentDir: "/tmp/test-agent",
    });

    const model = config.models?.providers?.["microsoft-foundry"]?.models[0];
    expect(model?.id).toBe("gpt-5.4");
    expect(model?.api).toBe("openai-responses");
    expect(model?.baseUrl).toBe("https://example.services.ai.azure.com/openai/v1");
    expect(config.models?.providers?.["microsoft-foundry"]?.api).toBe("openai-responses");
    expect(config.models?.providers?.["microsoft-foundry"]?.baseUrl).toBe(
      "https://example.services.ai.azure.com/openai/v1",
    );
  });

  it("accepts tenant domains as valid tenant identifiers", () => {
    expect(isValidTenantIdentifier("contoso.onmicrosoft.com")).toBe(true);
    expect(isValidTenantIdentifier("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(isValidTenantIdentifier("not a tenant")).toBe(false);
  });

  it("defaults Azure OpenAI model families to the documented API surfaces", () => {
    expect(usesFoundryResponsesByDefault("gpt-5.4")).toBe(true);
    expect(usesFoundryResponsesByDefault("gpt-5.2-codex")).toBe(true);
    expect(usesFoundryResponsesByDefault("o4-mini")).toBe(true);
    expect(usesFoundryResponsesByDefault("DeepSeek-V4-Pro")).toBe(true);
    expect(usesFoundryResponsesByDefault("DeepSeek-V4-Flash")).toBe(true);
    expect(usesFoundryResponsesByDefault("MAI-DS-R1")).toBe(false);
    expect(requiresFoundryMaxCompletionTokens("gpt-5.4")).toBe(true);
    expect(requiresFoundryMaxCompletionTokens("gpt-5-chat")).toBe(true);
    expect(requiresFoundryMaxCompletionTokens("o3")).toBe(true);
    expect(requiresFoundryMaxCompletionTokens("gpt-4o")).toBe(false);
    expect(supportsFoundryReasoningEffort("gpt-5.4")).toBe(true);
    expect(supportsFoundryReasoningEffort("gpt-5-chat")).toBe(false);
    expect(supportsFoundryReasoningEffort("gpt-5.1-chat")).toBe(true);
    expect(supportsFoundryReasoningEffort("o3")).toBe(true);
    expect(supportsFoundryReasoningEffort("o1-mini")).toBe(false);
    expect(supportsFoundryReasoningEffort("MAI-DS-R1")).toBe(false);
    expect(supportsFoundryReasoningContent("MAI-DS-R1")).toBe(true);
    expect(supportsFoundryImageInput("gpt-5.4")).toBe(true);
    expect(supportsFoundryImageInput("gpt-4o")).toBe(true);
    expect(supportsFoundryImageInput("MAI-DS-R1")).toBe(false);
    expect(isFoundryMaiImageModel("MAI-Image-2.5-Flash")).toBe(true);
    expect(isFoundryMaiImageModel("MAI-Image-2e")).toBe(true);
    expect(isFoundryMaiImageModel("MAI-DS-R1")).toBe(false);
  });

  it("labels all Foundry API surfaces for onboarding summaries", () => {
    expect(formatFoundryApiLabel("openai-completions")).toBe("Chat Completions");
    expect(formatFoundryApiLabel("openai-responses")).toBe("Responses");
    expect(formatFoundryApiLabel("anthropic-messages")).toBe("Anthropic Messages");
  });

  it("records MAI chat deployments with reasoning-content token limits", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "mai-r1-prod",
      modelNameHint: "MAI-DS-R1",
      api: "openai-completions",
      authMethod: "entra-id",
    });

    const model = requireFoundryProviderPatch(result).models[0];
    expect(model?.api).toBe("openai-completions");
    expect(model?.reasoning).toBe(true);
    expect(model?.contextWindow).toBe(163_840);
    expect(model?.maxTokens).toBe(163_840);
    expect(model?.input).toEqual(["text"]);
    expect(model?.compat?.supportsReasoningEffort).toBe(false);
    expect(model?.compat?.maxTokensField).toBe("max_tokens");
  });

  it("configures the image default for MAI image deployments", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "mai-image-prod",
      modelNameHint: "MAI-Image-2.5",
      api: "openai-completions",
      authMethod: "entra-id",
    });

    expect(result.configPatch?.agents?.defaults?.imageGenerationModel).toEqual({
      primary: "microsoft-foundry/mai-image-prod",
    });
    expect(result.defaultModel).toBeUndefined();
    expect(requireFoundryProviderPatch(result).models[0]?.name).toBe("MAI-Image-2.5");
  });

  it("skips chat connection probes for MAI image deployments", () => {
    expect(
      shouldTestFoundryTextConnection({
        modelId: "prod-image",
        modelNameHint: "MAI-Image-2.5",
      }),
    ).toBe(false);
    expect(
      shouldTestFoundryTextConnection({
        modelId: "prod-chat",
        modelNameHint: "gpt-5.4",
      }),
    ).toBe(true);
  });

  it("classifies custom API-key MAI image deployments during manual setup", async () => {
    const text = vi
      .fn()
      .mockResolvedValueOnce("https://example.services.ai.azure.com")
      .mockResolvedValueOnce("prod-image");
    const select = vi
      .fn()
      .mockResolvedValueOnce("mai-image")
      .mockResolvedValueOnce("MAI-Image-2.5");
    const selection = await promptApiKeyEndpointAndModel({
      prompter: {
        text,
        select,
      },
    } as never);

    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: "test-api-key",
      endpoint: selection.endpoint,
      modelId: selection.modelId,
      modelNameHint: selection.modelNameHint,
      api: selection.api,
      authMethod: "api-key",
    });

    expect(selection).toEqual({
      endpoint: "https://example.services.ai.azure.com",
      modelId: "prod-image",
      modelNameHint: "MAI-Image-2.5",
      api: "openai-completions",
    });
    expect(result.configPatch?.agents?.defaults?.imageGenerationModel).toEqual({
      primary: "microsoft-foundry/prod-image",
    });
    expect(result.defaultModel).toBeUndefined();
  });

  it("keeps API-key manual setup defaulted to chat completions for GPT deployments", async () => {
    const text = vi
      .fn()
      .mockResolvedValueOnce("https://example.services.ai.azure.com")
      .mockResolvedValueOnce("gpt-4o");
    const select = vi
      .fn()
      .mockImplementationOnce(async (params: { initialValue?: string }) => {
        expect(params.initialValue).toBe("other-chat");
        return "other-chat";
      })
      .mockImplementationOnce(async (params: { initialValue?: string }) => {
        expect(params.initialValue).toBe("openai-completions");
        return "openai-completions";
      });

    const selection = await promptApiKeyEndpointAndModel({
      prompter: {
        text,
        select,
      },
    } as never);

    expect(selection).toEqual({
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-4o",
      api: "openai-completions",
    });
  });

  it("does not reuse stale API-key model metadata when selecting a different deployment", async () => {
    const provider = registerProvider();
    ensureAuthProfileStoreMock.mockReturnValueOnce({
      profiles: {
        "microsoft-foundry:default": {
          type: "api_key",
          provider: "microsoft-foundry",
          metadata: {
            authMethod: "api-key",
            endpoint: "https://example.services.ai.azure.com",
            modelId: "prod-fable",
            modelName: "claude-fable-5",
            api: "anthropic-messages",
          },
        },
      },
    });
    const text = vi
      .fn()
      .mockResolvedValueOnce("https://example.services.ai.azure.com")
      .mockResolvedValueOnce("prod-gpt");
    const select = vi
      .fn()
      .mockResolvedValueOnce("other-chat")
      .mockResolvedValueOnce("openai-completions");
    const apiKeyAuth = provider.auth.find((method: { id: string }) => method.id === "api-key");

    const result = await apiKeyAuth?.run({
      config: {},
      opts: { azureOpenaiApiKey: "test-api-key" },
      prompter: { text, select },
      agentDir: defaultFoundryAgentDir,
      secretInputMode: "plaintext",
    } as never);

    const model = result?.configPatch?.models?.providers?.["microsoft-foundry"]?.models[0];
    expect(model).toMatchObject({
      id: "prod-gpt",
      name: "prod-gpt",
      api: "openai-completions",
      reasoning: false,
    });
    expect(model?.thinkingLevelMap).toBeUndefined();
  });

  it("rejects Entra-only Claude Mythos deployments during API-key manual setup", async () => {
    const text = vi.fn(
      async (params: { message: string; validate?: (value: string) => string | undefined }) => {
        if (params.message === "Microsoft Foundry endpoint URL") {
          return "https://example.services.ai.azure.com";
        }
        if (params.message === "Default model/deployment name") {
          return "prod-mythos";
        }
        if (params.message === "Claude base model") {
          expect(params.validate?.("claude-fable-5")).toBeUndefined();
          expect(params.validate?.("claude-mythos-preview")).toContain("Entra ID auth");
          return "claude-fable-5";
        }
        throw new Error(`unexpected prompt: ${params.message}`);
      },
    );
    const select = vi.fn().mockResolvedValueOnce("claude");

    const selection = await promptApiKeyEndpointAndModel({
      prompter: {
        text,
        select,
      },
    } as never);

    expect(selection).toEqual({
      endpoint: "https://example.services.ai.azure.com",
      modelId: "prod-mythos",
      modelNameHint: "claude-fable-5",
      api: "anthropic-messages",
    });
    expect(requiresFoundryEntraIdClaudeAuth("claude-mythos-preview")).toBe(true);
    expect(requiresFoundryEntraIdClaudeAuth("claude-fable-5")).toBe(false);
  });

  it("allows Entra-only Claude Mythos deployments during Entra manual setup", async () => {
    const text = vi.fn(
      async (params: { message: string; validate?: (value: string) => string | undefined }) => {
        if (params.message === "Microsoft Foundry endpoint URL") {
          return "https://example.services.ai.azure.com";
        }
        if (params.message === "Default model/deployment name") {
          return "prod-mythos";
        }
        if (params.message === "Claude base model") {
          expect(params.validate?.("claude-mythos-preview")).toBeUndefined();
          return "claude-mythos-preview";
        }
        throw new Error(`unexpected prompt: ${params.message}`);
      },
    );
    const select = vi.fn().mockResolvedValueOnce("claude");

    const selection = await promptEndpointAndModelManually({
      prompter: {
        text,
        select,
      },
    } as never);

    expect(selection).toEqual({
      endpoint: "https://example.services.ai.azure.com",
      modelId: "prod-mythos",
      modelNameHint: "claude-mythos-preview",
      api: "anthropic-messages",
    });
  });

  it("uses discovered deployment metadata for MAI image defaults", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "custom-image-prod",
      api: "openai-completions",
      authMethod: "entra-id",
      deployments: [
        { name: "custom-image-prod", modelName: "MAI-Image-2.5-Flash" },
        { name: "custom-chat-prod", modelName: "gpt-5.4", api: "openai-responses" },
      ],
    });

    expect(result.configPatch?.agents?.defaults?.imageGenerationModel).toEqual({
      primary: "microsoft-foundry/custom-image-prod",
    });
    expect(result.defaultModel).toBeUndefined();
  });

  it("records GPT-family Foundry deployments as image-capable during auth setup", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "deployment-gpt5",
      modelNameHint: "gpt-5.4",
      api: "openai-responses",
      authMethod: "entra-id",
    });

    expect(result.configPatch?.models?.providers?.["microsoft-foundry"]?.models[0]?.input).toEqual([
      "text",
      "image",
    ]);
  });

  it("normalizes stale resolved Foundry rows to provider-owned image capability metadata", () => {
    const provider = registerProvider();

    const normalized = provider.normalizeResolvedModel?.({
      provider: "microsoft-foundry",
      modelId: "deployment-gpt5",
      model: buildFoundryModel({
        id: "deployment-gpt5",
        name: "gpt-5.4",
        input: ["text"],
        compat: { supportsStrictMode: false },
      }),
    });

    expect(normalized?.name).toBe("gpt-5.4");
    expect(normalized?.api).toBe("openai-responses");
    expect(normalized?.reasoning).toBe(true);
    expect(normalized?.input).toEqual(["text", "image"]);
    expect(normalized?.baseUrl).toBe("https://example.services.ai.azure.com/openai/v1");
    expect(normalized?.compat?.supportsStore).toBe(false);
    expect(normalized?.compat?.supportsStrictMode).toBe(false);
    expect(normalized?.compat?.maxTokensField).toBe("max_completion_tokens");
  });

  it("preserves explicit image capability for non-heuristic Foundry deployments", () => {
    const provider = registerProvider();

    const normalized = provider.normalizeResolvedModel?.({
      provider: "microsoft-foundry",
      modelId: "custom-vision-deployment",
      model: buildFoundryModel({
        id: "custom-vision-deployment",
        name: "internal alias",
        input: ["text", "image"],
      }),
    });

    expect(normalized?.name).toBe("internal alias");
    expect(normalized?.input).toEqual(["text", "image"]);
  });

  it("preserves explicit reasoning capability for non-heuristic Foundry aliases", () => {
    const provider = registerProvider();

    const normalized = provider.normalizeResolvedModel?.({
      provider: "microsoft-foundry",
      modelId: "prod-primary",
      model: buildFoundryModel({
        id: "prod-primary",
        name: "production alias",
        api: "openai-completions",
        reasoning: true,
      }),
    });

    expect(normalized?.name).toBe("production alias");
    expect(normalized?.reasoning).toBe(true);
    expect(normalized?.compat?.supportsReasoningEffort).toBe(true);
    expect(normalized?.compat?.maxTokensField).toBe("max_completion_tokens");
  });

  it("preserves explicit reasoning_effort opt-outs for Foundry aliases", () => {
    const provider = registerProvider();

    const normalized = provider.normalizeResolvedModel?.({
      provider: "microsoft-foundry",
      modelId: "prod-primary",
      model: buildFoundryModel({
        id: "prod-primary",
        name: "production alias",
        api: "openai-completions",
        reasoning: true,
        compat: { supportsReasoningEffort: false },
      }),
    });

    expect(normalized?.reasoning).toBe(true);
    expect(normalized?.compat?.supportsReasoningEffort).toBe(false);
  });

  it("deletes legacy provider-level credentials for API-key profiles", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: "test-api-key",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-4o",
      api: "openai-responses",
      authMethod: "api-key",
    });

    const provider = requireFoundryProviderPatch(result);
    expect(provider.apiKey).toBeUndefined();
    expect(provider.authHeader).toBeUndefined();
    expect(provider.headers).toBeUndefined();
    expect(Object.hasOwn(provider, "apiKey")).toBe(true);
    expect(Object.hasOwn(provider, "authHeader")).toBe(true);
    expect(Object.hasOwn(provider, "headers")).toBe(true);
  });

  it("uses the minimum supported response token count for GPT-5 connection tests", () => {
    const testRequest = buildFoundryConnectionTest({
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5.4",
      modelNameHint: "gpt-5.4",
      api: "openai-responses",
    });

    expect(testRequest.url).toContain("/responses");
    expect(testRequest.body.model).toBe("gpt-5.4");
    expect(testRequest.body.max_output_tokens).toBe(16);
  });

  it("marks Foundry responses models to omit explicit store=false payloads", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5.2-codex",
      modelNameHint: "gpt-5.2-codex",
      api: "openai-responses",
      authMethod: "entra-id",
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.models[0]?.compat?.supportsStore).toBe(false);
    expect(provider?.models[0]?.compat?.maxTokensField).toBe("max_completion_tokens");
  });

  it("keeps replay item ids for Foundry encrypted reasoning continuations", async () => {
    const provider = registerProvider();
    let capturedReplayIds: boolean | undefined;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      capturedReplayIds = (options as { replayResponsesItemIds?: boolean } | undefined)
        ?.replayResponsesItemIds;
      return {} as never;
    };

    const wrappedStreamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      modelId: "gpt-5.4",
      model: buildFoundryModel({
        reasoning: true,
        compat: { supportsStore: false },
      }),
      extraParams: {},
      config: {},
      agentDir: defaultFoundryAgentDir,
    } as never);

    expect(wrappedStreamFn).toBeTypeOf("function");
    await wrappedStreamFn?.(
      buildFoundryModel({
        reasoning: true,
        compat: { supportsStore: false },
      }) as never,
      { systemPrompt: "system", messages: [] } as never,
      {},
    );

    expect(capturedReplayIds).toBe(true);
  });

  it("leaves Foundry chat completions streams unwrapped by Responses defaults", () => {
    const provider = registerProvider();
    const baseStreamFn: StreamFn = () => ({}) as never;

    expect(
      provider.wrapStreamFn?.({
        streamFn: baseStreamFn,
        modelId: "gpt-4o-mini",
        model: buildFoundryModel({
          id: "gpt-4o-mini",
          name: "gpt-4o-mini",
          api: "openai-completions",
        }),
        extraParams: {},
        config: {},
        agentDir: defaultFoundryAgentDir,
      } as never),
    ).toBe(baseStreamFn);
  });

  it("marks Foundry chat models as not supporting reasoning_effort", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: "test-api-key",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-4o-mini",
      modelNameHint: "gpt-4o-mini",
      api: "openai-completions",
      authMethod: "api-key",
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.models[0]?.reasoning).toBe(false);
    expect(provider?.models[0]?.compat?.supportsReasoningEffort).toBe(false);
    expect(provider?.models[0]?.compat?.maxTokensField).toBe("max_tokens");
  });

  it("routes Claude deployments through Foundry Anthropic Messages", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com/openai/v1",
      modelId: "prod-fable",
      modelNameHint: "claude-fable-5",
      api: "anthropic-messages",
      authMethod: "entra-id",
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.baseUrl).toBe("https://example.services.ai.azure.com/anthropic");
    expect(provider?.api).toBe("anthropic-messages");
    expect(provider?.authHeader).toBeUndefined();
    expect(provider?.models[0]).toMatchObject({
      id: "prod-fable",
      name: "claude-fable-5",
      api: "anthropic-messages",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    });
    expect(provider?.models[0]?.compat).toBeUndefined();
  });

  it("deletes legacy provider-level credentials for Entra profiles", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com/openai/v1",
      modelId: "prod-fable",
      modelNameHint: "claude-fable-5",
      api: "anthropic-messages",
      authMethod: "entra-id",
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"] as
      | Record<string, unknown>
      | undefined;
    expect(provider?.authHeader).toBeUndefined();
    expect(Object.hasOwn(provider ?? {}, "apiKey")).toBe(true);
    expect(Object.hasOwn(provider ?? {}, "authHeader")).toBe(true);
    expect(Object.hasOwn(provider ?? {}, "headers")).toBe(true);
    expect(provider?.apiKey).toBeUndefined();
    expect(provider?.headers).toBeUndefined();
  });

  it.each([
    ["claude-mythos-preview", 128_000],
    ["claude-fable-5", 128_000],
    ["claude-opus-4.8", 128_000],
    ["claude-opus-4.7", 128_000],
    ["claude-opus-4.6", 128_000],
    ["claude-sonnet-4.6", 128_000],
    ["claude-opus-4.5", 64_000],
    ["claude-sonnet-4.5", 64_000],
    ["claude-haiku-4.5", 64_000],
    ["claude-opus-4.1", 32_000],
  ] as const)("preserves Foundry Claude token limits for %s", (modelNameHint, maxTokens) => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: `prod-${modelNameHint.replaceAll(".", "-")}`,
      modelNameHint,
      api: "anthropic-messages",
      authMethod: "entra-id",
    });

    expect(result.configPatch?.models?.providers?.["microsoft-foundry"]?.models[0]).toMatchObject({
      name: modelNameHint,
      api: "anthropic-messages",
      contextWindow: maxTokens === 128_000 ? 1_000_000 : 200_000,
      maxTokens,
    });
  });

  it("keeps older Foundry Claude deployments out of Fable-class thinking limits", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "prod-claude-35",
      modelNameHint: "claude-3.5-sonnet",
      api: "anthropic-messages",
      authMethod: "entra-id",
    });

    const model = result.configPatch?.models?.providers?.["microsoft-foundry"]?.models[0];
    expect(model).toMatchObject({
      id: "prod-claude-35",
      name: "claude-3.5-sonnet",
      api: "anthropic-messages",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
    expect(model?.thinkingLevelMap).toBeUndefined();
    expect(model?.compat).toBeUndefined();
  });

  it("resolves Claude thinking profiles from configured Foundry model names", () => {
    const provider = registerProvider();

    expect(
      provider.resolveThinkingProfile?.({
        provider: "microsoft-foundry",
        modelId: "prod-fable",
        params: { canonicalModelId: "claude-fable-5" },
      }),
    ).toMatchObject({
      defaultLevel: "high",
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "xhigh" },
        { id: "adaptive" },
        { id: "max" },
      ],
    });
    for (const modelName of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(
        provider.resolveThinkingProfile?.({
          provider: "microsoft-foundry",
          modelId: `prod-${modelName}`,
          params: { canonicalModelId: modelName },
        }),
      ).toMatchObject({
        defaultLevel: "adaptive",
        levels: [
          { id: "off" },
          { id: "minimal" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          { id: "adaptive" },
          { id: "max" },
        ],
      });
    }
    for (const modelName of [
      "claude-opus-4-1",
      "claude-opus-4-5",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]) {
      expect(
        provider.resolveThinkingProfile?.({
          provider: "microsoft-foundry",
          modelId: `prod-${modelName}`,
          params: { canonicalModelId: modelName },
        }),
      ).toMatchObject({
        levels: [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      });
    }
    expect(
      provider.resolveThinkingProfile?.({
        provider: "microsoft-foundry",
        modelId: "prod-opaque",
      }),
    ).toBeUndefined();
    expect(
      provider.resolveThinkingProfile?.({
        provider: "microsoft-foundry",
        modelId: "prod-mythos-preview",
        params: { canonicalModelId: "claude-mythos-preview" },
      }),
    ).toMatchObject({
      defaultLevel: "adaptive",
      levels: [
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "adaptive" },
      ],
    });
  });

  it("does not record native max thinking maps for Foundry Mythos Preview deployments", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "prod-mythos-preview",
      modelNameHint: "claude-mythos-preview",
      api: "anthropic-messages",
      authMethod: "entra-id",
    });

    const model = result.configPatch?.models?.providers?.["microsoft-foundry"]?.models[0];
    expect(model?.thinkingLevelMap).toBeUndefined();
    expect(model?.params).toMatchObject({ canonicalModelId: "claude-mythos-preview" });
  });

  it("keeps Foundry chat reasoning_effort enabled for GPT-5 reasoning deployments", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: "test-api-key",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5.1-chat",
      modelNameHint: "gpt-5.1-chat",
      api: "openai-completions",
      authMethod: "api-key",
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.models[0]?.reasoning).toBe(true);
    expect(provider?.models[0]?.thinkingLevelMap?.minimal).toBe(null);
    expect(provider?.models[0]?.thinkingLevelMap?.off).toBe("none");
    expect(provider?.models[0]?.compat?.supportsReasoningEffort).toBe(true);
    expect(provider?.models[0]?.compat?.supportedReasoningEfforts).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(provider?.models[0]?.compat?.maxTokensField).toBe("max_completion_tokens");
  });

  it("emits only persisted-schema thinkingLevelMap level keys for Entra ID reasoning onboarding (openclaw#91011)", () => {
    // The persisted ModelDefinitionSchema only accepts these ModelThinkingLevel keys; if the writer
    // emits one outside the set, updateConfig rolls the Entra ID onboarding write back.
    const allowedThinkingLevels = new Set([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5.1-chat",
      modelNameHint: "gpt-5.1-chat",
      api: "openai-responses",
      authMethod: "entra-id",
    });

    const thinkingLevelMap =
      result.configPatch?.models?.providers?.["microsoft-foundry"]?.models[0]?.thinkingLevelMap;
    expect(thinkingLevelMap).toBeDefined();
    for (const [level, value] of Object.entries(thinkingLevelMap ?? {})) {
      expect(allowedThinkingLevels.has(level)).toBe(true);
      expect(value === null || typeof value === "string").toBe(true);
    }
  });

  it("records model-name reasoning effort limits for Foundry deployment aliases", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: "test-api-key",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "deployment-codex-mini",
      modelNameHint: "gpt-5.1-codex-mini",
      api: "openai-completions",
      authMethod: "api-key",
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.models[0]?.reasoning).toBe(true);
    expect(provider?.models[0]?.compat?.supportsReasoningEffort).toBe(true);
    expect(provider?.models[0]?.compat?.supportedReasoningEfforts).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
  });

  it("omits minimal from newer Foundry GPT-5.x reasoning effort metadata", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: "test-api-key",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5.2",
      modelNameHint: "gpt-5.2",
      api: "openai-completions",
      authMethod: "api-key",
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.models[0]?.thinkingLevelMap?.minimal).toBe(null);
    expect(provider?.models[0]?.compat?.supportedReasoningEfforts).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
  });

  it("omits minimal from Foundry GPT-5 Codex reasoning effort metadata", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: "test-api-key",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5-codex",
      modelNameHint: "gpt-5-codex",
      api: "openai-completions",
      authMethod: "api-key",
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.models[0]?.thinkingLevelMap?.minimal).toBe(null);
    expect(provider?.models[0]?.compat?.supportedReasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("keeps Foundry gpt-5-chat deployments non-reasoning while using max_completion_tokens", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: "test-api-key",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5-chat",
      modelNameHint: "gpt-5-chat",
      api: "openai-completions",
      authMethod: "api-key",
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.models[0]?.reasoning).toBe(false);
    expect(provider?.models[0]?.compat?.supportsReasoningEffort).toBe(false);
    expect(provider?.models[0]?.compat?.maxTokensField).toBe("max_completion_tokens");
  });

  it("keeps persisted response-mode routing for custom deployment aliases", async () => {
    const provider = registerProvider();
    const config: OpenClawConfig = {
      auth: {
        profiles: {
          "microsoft-foundry:entra": {
            provider: "microsoft-foundry",
            mode: "api_key" as const,
          },
        },
        order: {
          "microsoft-foundry": ["microsoft-foundry:entra"],
        },
      },
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            api: "openai-responses",
            models: [
              {
                id: "prod-primary",
                name: "production alias",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    };

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/prod-primary",
      prompter: {} as never,
      agentDir: "/tmp/test-agent",
    });

    expect(config.models?.providers?.["microsoft-foundry"]?.api).toBe("openai-responses");
    expect(config.models?.providers?.["microsoft-foundry"]?.baseUrl).toBe(
      "https://example.services.ai.azure.com/openai/v1",
    );
    expect(config.models?.providers?.["microsoft-foundry"]?.models[0]?.api).toBe(
      "openai-responses",
    );
  });

  it("normalizes pasted Azure chat completion request URLs to the resource endpoint", () => {
    expect(
      normalizeFoundryEndpoint(
        "https://example.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-12-01-preview",
      ),
    ).toBe("https://example.openai.azure.com");
  });

  it("preserves project-scoped endpoint prefixes when extracting the Foundry endpoint", async () => {
    const provider = registerProvider();
    mockAzureCliToken({ accessToken: "test-token-placeholder", expiresInMs: 60_000 });
    ensureAuthProfileStoreMock.mockReturnValueOnce({ profiles: {} });

    const prepared = await provider.prepareRuntimeAuth?.(
      buildFoundryRuntimeAuthContext({
        modelId: "deployment-gpt5",
        model: buildFoundryModel({
          id: "deployment-gpt5",
          baseUrl: "https://example.services.ai.azure.com/api/projects/demo/openai/v1/responses",
        }),
      }),
    );

    expect(prepared?.baseUrl).toBe(
      "https://example.services.ai.azure.com/api/projects/demo/openai/v1",
    );
  });

  it("normalizes pasted Foundry responses request URLs to the resource endpoint", () => {
    expect(
      normalizeFoundryEndpoint(
        "https://example.services.ai.azure.com/openai/v1/responses?api-version=preview",
      ),
    ).toBe("https://example.services.ai.azure.com");
  });

  it("includes api-version for non GPT-5 chat completion connection tests", () => {
    const testRequest = buildFoundryConnectionTest({
      endpoint: "https://example.services.ai.azure.com",
      modelId: "FW-GLM-5",
      modelNameHint: "FW-GLM-5",
      api: "openai-completions",
    });

    expect(testRequest.url).toContain("/chat/completions");
    expect(testRequest.body.model).toBe("FW-GLM-5");
    expect(testRequest.body.max_tokens).toBe(1);
  });

  it("builds Anthropic Messages connection tests for Claude deployments", () => {
    const testRequest = buildFoundryConnectionTest({
      endpoint: "https://example.services.ai.azure.com/openai/v1",
      modelId: "prod-fable",
      modelNameHint: "claude-fable-5",
      api: "anthropic-messages",
    });

    expect(testRequest.url).toBe("https://example.services.ai.azure.com/anthropic/v1/messages");
    expect(testRequest.body).toEqual({
      model: "prod-fable",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      thinking: { type: "adaptive" },
    });
  });

  it("returns actionable Azure CLI login errors", async () => {
    mockAzureCliLoginFailure();

    await expect(getAccessTokenResultAsync()).rejects.toThrow("Azure CLI is not logged in");
  });

  it("keeps bounded Azure CLI error details UTF-16 safe", async () => {
    const prefix = "x".repeat(299);
    execFileMock.mockRejectedValueOnce(
      Object.assign(new Error("az failed"), { stderr: `${prefix}😀tail`, stdout: "" }),
    );

    await expect(getAccessTokenResultAsync()).rejects.toMatchObject({
      message: `az failed: ${prefix}`,
    });
  });

  it("deletes legacy provider-level secret refs", () => {
    const secretRef = {
      source: "env" as const,
      provider: "default",
      id: "AZURE_OPENAI_API_KEY",
    };
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: secretRef,
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-4o",
      api: "openai-responses",
      authMethod: "api-key",
    });

    const provider = requireFoundryProviderPatch(result);
    expect(provider.apiKey).toBeUndefined();
    expect(provider.authHeader).toBeUndefined();
    expect(provider.headers).toBeUndefined();
    expect(Object.hasOwn(provider, "apiKey")).toBe(true);
    expect(Object.hasOwn(provider, "authHeader")).toBe(true);
    expect(Object.hasOwn(provider, "headers")).toBe(true);
  });

  it("moves the selected Foundry auth profile to the front of auth.order", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5.4",
      api: "openai-responses",
      authMethod: "entra-id",
      currentProviderProfileIds: ["microsoft-foundry:default", "microsoft-foundry:entra"],
    });

    expect(result.configPatch?.auth?.order?.["microsoft-foundry"]).toEqual([
      "microsoft-foundry:entra",
      "microsoft-foundry:default",
    ]);
  });

  it("keeps Foundry profile selection compatible with unrelated AWS SDK profile modes", async () => {
    const provider = registerProvider();
    const config: OpenClawConfig = {
      ...buildFoundryConfig({
        profileIds: ["microsoft-foundry:entra"],
        orderedProfileIds: ["microsoft-foundry:entra"],
      }),
      auth: {
        profiles: {
          "amazon-bedrock:default": {
            provider: "amazon-bedrock",
            mode: "aws-sdk",
          },
          "microsoft-foundry:entra": {
            provider: "microsoft-foundry",
            mode: "api_key",
          },
        },
        order: {
          "microsoft-foundry": ["microsoft-foundry:entra"],
        },
      },
    };

    await provider.onModelSelected?.({
      config,
      model: "microsoft-foundry/gpt-5.4",
      prompter: {} as never,
      agentDir: defaultFoundryAgentDir,
    });

    expect(config.auth?.order?.["microsoft-foundry"]).toEqual(["microsoft-foundry:entra"]);
  });

  it("persists discovered deployments alongside the selected default model", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:entra",
      apiKey: "__entra_id_dynamic__",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "deployment-gpt5",
      modelNameHint: "gpt-5.4",
      api: "openai-responses",
      authMethod: "entra-id",
      deployments: [
        { name: "deployment-gpt5", modelName: "gpt-5.4", api: "openai-responses" },
        { name: "deployment-gpt4o", modelName: "gpt-4o", api: "openai-responses" },
        { name: "deployment-fable", modelName: "claude-fable-5", api: "anthropic-messages" },
      ],
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.models.map((model) => model.id)).toEqual([
      "deployment-gpt5",
      "deployment-gpt4o",
      "deployment-fable",
    ]);
    expect(provider?.models.map((model) => [model.id, model.baseUrl])).toEqual([
      ["deployment-gpt5", "https://example.services.ai.azure.com/openai/v1"],
      ["deployment-gpt4o", "https://example.services.ai.azure.com/openai/v1"],
      ["deployment-fable", "https://example.services.ai.azure.com/anthropic"],
    ]);
    expect(result.defaultModel).toBe("microsoft-foundry/deployment-gpt5");
  });
});

describe("selectFoundryDeployment", () => {
  function makeCtx(overrides: { selectValue?: string } = {}) {
    const noteCalls: Array<{ message: string; title: string }> = [];
    const selectCalls: Array<{ options: Array<{ value: string }> }> = [];
    const ctx = {
      prompter: {
        note: vi.fn(async (message: string, title: string) => {
          noteCalls.push({ message, title });
        }),
        select: vi.fn(async (params: { options: Array<{ value: string }> }) => {
          selectCalls.push({ options: params.options });
          return overrides.selectValue ?? params.options[0]?.value;
        }),
      },
    } as never;
    return { ctx, noteCalls, selectCalls };
  }

  const fakeResource = {
    id: "/sub/x/rg/y/account/z",
    accountName: "foundry-resource",
    kind: "AIServices" as const,
    resourceGroup: "rg",
    endpoint: "https://example.services.ai.azure.com",
    projects: [],
  };

  it("offers and returns Claude deployments alongside GPT resources", async () => {
    const { ctx, selectCalls, noteCalls } = makeCtx({ selectValue: "prod-gpt" });
    const result = await selectFoundryDeployment(ctx, fakeResource, [
      { name: "prod-gpt", modelName: "gpt-5.4", state: "Succeeded" },
      { name: "prod-claude", modelName: "claude-opus-4-6", state: "Succeeded" },
      { name: "prod-mini", modelName: "gpt-4o-mini", state: "Succeeded" },
    ]);

    expect(result.supported.map((deployment) => deployment.name)).toEqual([
      "prod-gpt",
      "prod-claude",
      "prod-mini",
    ]);
    expect(result.selected.name).toBe("prod-gpt");
    expect(selectCalls[0]?.options.map((option) => option.value)).toEqual([
      "prod-gpt",
      "prod-claude",
      "prod-mini",
    ]);
    expect(noteCalls.some((call) => call.title === "Unsupported Deployments")).toBe(false);
  });

  it("uses Anthropic-only deployment resources directly", async () => {
    const { ctx, noteCalls } = makeCtx();

    const result = await selectFoundryDeployment(ctx, fakeResource, [
      { name: "only-claude", modelName: "claude-3.5-sonnet", state: "Succeeded" },
    ]);

    expect(result).toEqual({
      selected: { name: "only-claude", modelName: "claude-3.5-sonnet", state: "Succeeded" },
      supported: [{ name: "only-claude", modelName: "claude-3.5-sonnet", state: "Succeeded" }],
    });
    expect(noteCalls.some((call) => call.title === "Unsupported Deployments")).toBe(false);
  });

  it("leaves all-OpenAI resources unchanged", async () => {
    const { ctx, selectCalls, noteCalls } = makeCtx({ selectValue: "prod-mini" });
    const result = await selectFoundryDeployment(ctx, fakeResource, [
      { name: "prod-gpt", modelName: "gpt-5.4", state: "Succeeded" },
      { name: "prod-mini", modelName: "gpt-4o-mini", state: "Succeeded" },
    ]);

    expect(result.supported.map((deployment) => deployment.name)).toEqual([
      "prod-gpt",
      "prod-mini",
    ]);
    expect(result.selected.name).toBe("prod-mini");
    expect(selectCalls).toHaveLength(1);
    expect(noteCalls.some((call) => call.title === "Unsupported Deployments")).toBe(false);
  });
});

describe("isAnthropicFoundryDeployment", () => {
  it.each(["claude-opus-4-6", "Claude-Sonnet-4", "claude-3.5-haiku", "CLAUDE-instant"])(
    "detects Anthropic model: %s",
    (name) => {
      expect(isAnthropicFoundryDeployment(name)).toBe(true);
    },
  );

  it.each(["gpt-5.4", "o4-mini", "phi-4", "llama-3", undefined, null, ""])(
    "rejects non-Anthropic model: %s",
    (name) => {
      expect(isAnthropicFoundryDeployment(name)).toBe(false);
    },
  );
});
describe("azLoginDeviceCodeWithOptions utf-8 chunk boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
  });

  it("reassembles split-byte UTF-8 across both spawned process streams", async () => {
    const { PassThrough } = await import("node:stream");
    const { EventEmitter } = await import("node:events");

    const stdout = new PassThrough();
    const stderr = new PassThrough();

    // Build a fake ChildProcess that mirrors spawn()'s return shape
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      pid: 99999,
    });

    spawnMock.mockReturnValue(child);
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const loginPromise = azLoginDeviceCodeWithOptions({});

    const writeSplitUtf8 = (stream: typeof stdout, text: string) => {
      const bytes = Buffer.from(text);
      stream.write(bytes.subarray(0, 2));
      stream.write(bytes.subarray(2));
    };
    writeSplitUtf8(stderr, "😊");
    writeSplitUtf8(stdout, "🚀");
    stderr.end();
    stdout.end();

    child.emit("close", 1);

    const err = await loginPromise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("az login exited with code 1: 😊🚀");
    expect(stdoutWriteSpy).toHaveBeenCalledWith("🚀");
    expect(stderrWriteSpy).toHaveBeenCalledWith("😊");
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
