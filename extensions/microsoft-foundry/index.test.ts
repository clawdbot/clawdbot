import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import { getAccessTokenResultAsync } from "./cli.js";
import plugin from "./index.js";
import { buildFoundryConnectionTest, isValidTenantIdentifier } from "./onboard.js";
import { resetFoundryRuntimeAuthCaches } from "./runtime.js";
import {
  buildFoundryAuthResult,
  normalizeFoundryEndpoint,
  requiresFoundryMaxCompletionTokens,
  supportsFoundryImageInput,
  usesFoundryResponsesByDefault,
} from "./shared.js";

const execFileMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const ensureAuthProfileStoreMock = vi.hoisted(() =>
  vi.fn(() => ({
    profiles: {},
  })),
);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: execFileMock,
    execFileSync: execFileSyncMock,
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
  return registerProviderMock.mock.calls[0]?.[0];
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
    api: "openai-responses" | "openai-completions";
    baseUrl: string;
    input: Array<"text" | "image">;
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
  execFileMock.mockImplementationOnce(
    (
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const respond = () =>
        callback(
          null,
          JSON.stringify({
            accessToken: params.accessToken,
            expiresOn: new Date(Date.now() + params.expiresInMs).toISOString(),
          }),
          "",
        );
      if (params.delayMs) {
        setTimeout(respond, params.delayMs);
        return;
      }
      respond();
    },
  );
}

function mockAzureCliLoginFailure(delayMs?: number) {
  execFileMock.mockImplementationOnce(
    (
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const respond = () => {
        callback(new Error("az failed"), "", defaultAzureCliLoginError);
      };
      if (delayMs) {
        setTimeout(respond, delayMs);
        return;
      }
      respond();
    },
  );
}

describe("microsoft-foundry plugin", () => {
  beforeEach(() => {
    resetFoundryRuntimeAuthCaches();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    ensureAuthProfileStoreMock.mockReset();
    ensureAuthProfileStoreMock.mockReturnValue({ profiles: {} });
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

  it("preserves the model-derived base URL for Entra runtime auth refresh", async () => {
    const provider = registerProvider();
    mockAzureCliToken({ accessToken: "test-token", expiresInMs: 60_000 });
    ensureAuthProfileStoreMock.mockReturnValueOnce(buildEntraProfileStore());

    const prepared = await provider.prepareRuntimeAuth?.(buildFoundryRuntimeAuthContext());

    expect(prepared?.baseUrl).toBe("https://example.services.ai.azure.com/openai/v1");
  });

  it("retries Entra token refresh after a failed attempt", async () => {
    const provider = registerProvider();
    mockAzureCliLoginFailure();
    mockAzureCliToken({ accessToken: "retry-token", expiresInMs: 10 * 60_000 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const runtimeContext = buildFoundryRuntimeAuthContext();

    await expect(provider.prepareRuntimeAuth?.(runtimeContext)).rejects.toThrow(
      "Azure CLI is not logged in",
    );

    await expect(provider.prepareRuntimeAuth?.(runtimeContext)).resolves.toMatchObject({
      apiKey: "retry-token",
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent Entra token refreshes for the same profile", async () => {
    const provider = registerProvider();
    mockAzureCliToken({ accessToken: "deduped-token", expiresInMs: 60_000, delayMs: 10 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const runtimeContext = buildFoundryRuntimeAuthContext();

    const [first, second] = await Promise.all([
      provider.prepareRuntimeAuth?.(runtimeContext),
      provider.prepareRuntimeAuth?.(runtimeContext),
    ]);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(first?.apiKey).toBe("deduped-token");
    expect(second?.apiKey).toBe("deduped-token");
  });

  it("clears failed refresh state so later concurrent retries succeed", async () => {
    const provider = registerProvider();
    mockAzureCliLoginFailure(10);
    mockAzureCliToken({ accessToken: "recovered-token", expiresInMs: 10 * 60_000, delayMs: 10 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const runtimeContext = buildFoundryRuntimeAuthContext();

    const failed = await Promise.allSettled([
      provider.prepareRuntimeAuth?.(runtimeContext),
      provider.prepareRuntimeAuth?.(runtimeContext),
    ]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const [first, second] = await Promise.all([
      provider.prepareRuntimeAuth?.(runtimeContext),
      provider.prepareRuntimeAuth?.(runtimeContext),
    ]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(first?.apiKey).toBe("recovered-token");
    expect(second?.apiKey).toBe("recovered-token");
  });

  it("refreshes again when a cached token is too close to expiry", async () => {
    const provider = registerProvider();
    mockAzureCliToken({ accessToken: "soon-expiring-token", expiresInMs: 60_000 });
    mockAzureCliToken({ accessToken: "fresh-token", expiresInMs: 10 * 60_000 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const runtimeContext = buildFoundryRuntimeAuthContext();

    await expect(provider.prepareRuntimeAuth?.(runtimeContext)).resolves.toMatchObject({
      apiKey: "soon-expiring-token",
    });
    await expect(provider.prepareRuntimeAuth?.(runtimeContext)).resolves.toMatchObject({
      apiKey: "fresh-token",
    });
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

  it("accepts tenant domains as valid tenant identifiers", () => {
    expect(isValidTenantIdentifier("contoso.onmicrosoft.com")).toBe(true);
    expect(isValidTenantIdentifier("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(isValidTenantIdentifier("not a tenant")).toBe(false);
  });

  it("defaults Azure OpenAI model families to the documented API surfaces", () => {
    expect(usesFoundryResponsesByDefault("gpt-5.4")).toBe(true);
    expect(usesFoundryResponsesByDefault("gpt-5.2-codex")).toBe(true);
    expect(usesFoundryResponsesByDefault("o4-mini")).toBe(true);
    expect(usesFoundryResponsesByDefault("MAI-DS-R1")).toBe(false);
    expect(requiresFoundryMaxCompletionTokens("gpt-5.4")).toBe(true);
    expect(requiresFoundryMaxCompletionTokens("o3")).toBe(true);
    expect(requiresFoundryMaxCompletionTokens("gpt-4o")).toBe(false);
    expect(supportsFoundryImageInput("gpt-5.4")).toBe(true);
    expect(supportsFoundryImageInput("gpt-4o")).toBe(true);
    expect(supportsFoundryImageInput("MAI-DS-R1")).toBe(false);
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
      }),
    });

    expect(normalized).toMatchObject({
      name: "gpt-5.4",
      api: "openai-responses",
      input: ["text", "image"],
      baseUrl: "https://example.services.ai.azure.com/openai/v1",
      compat: {
        supportsStore: false,
        maxTokensField: "max_completion_tokens",
      },
    });
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

    expect(normalized).toMatchObject({
      name: "internal alias",
      input: ["text", "image"],
    });
  });

  it("writes Azure API key header overrides for API-key auth configs", () => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      apiKey: "test-api-key",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-4o",
      api: "openai-responses",
      authMethod: "api-key",
    });

    expect(result.configPatch?.models?.providers?.["microsoft-foundry"]).toMatchObject({
      apiKey: "test-api-key",
      authHeader: false,
      headers: { "api-key": "test-api-key" },
    });
  });

  it("uses the minimum supported response token count for GPT-5 connection tests", () => {
    const testRequest = buildFoundryConnectionTest({
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5.4",
      modelNameHint: "gpt-5.4",
      api: "openai-responses",
    });

    expect(testRequest.url).toContain("/responses");
    expect(testRequest.body).toMatchObject({
      model: "gpt-5.4",
      max_output_tokens: 16,
    });
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
    expect(provider?.models[0]?.compat).toMatchObject({
      supportsStore: false,
      maxTokensField: "max_completion_tokens",
    });
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
                api: "openai-responses",
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
    mockAzureCliToken({ accessToken: "test-token", expiresInMs: 60_000 });
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
    expect(testRequest.body).toMatchObject({
      model: "FW-GLM-5",
      max_tokens: 1,
    });
  });

  it("returns actionable Azure CLI login errors", async () => {
    mockAzureCliLoginFailure();

    await expect(getAccessTokenResultAsync()).rejects.toThrow("Azure CLI is not logged in");
  });

  it("keeps Azure API key header overrides when API-key auth uses a secret ref", () => {
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

    expect(result.configPatch?.models?.providers?.["microsoft-foundry"]).toMatchObject({
      apiKey: secretRef,
      authHeader: false,
      headers: { "api-key": secretRef },
    });
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
      ],
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.models.map((model) => model.id)).toEqual([
      "deployment-gpt5",
      "deployment-gpt4o",
    ]);
    expect(result.defaultModel).toBe("microsoft-foundry/deployment-gpt5");
  });
});
