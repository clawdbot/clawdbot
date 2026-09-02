// Openzoo tests cover setup plugin behavior.
import {
  createNonExitingRuntimeEnv,
  createQueuedWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER, type OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import type {
  ProviderAuthMethodNonInteractiveContext,
  ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  }),
}));

import {
  buildOpenzooModelDefinition,
  OPENZOO_LOCAL_API_KEY_PLACEHOLDER,
} from "./provider-models.js";
import {
  configureOpenzooNonInteractive,
  detectAppGuidedOpenzooAvailability,
  detectAppGuidedOpenzooModel,
  discoverOpenzooProvider,
  fetchOpenzooInfo,
  mergeOpenzooModels,
  prepareAppGuidedOpenzooSetup,
  promptAndConfigureOpenzooInteractive,
  selectOpenzooDefaultModelRef,
  validateOpenzooNonInteractive,
} from "./setup.js";

const DEFAULT_BASE_URL = "http://localhost:8402/v1";
const STATIC_AUTO = buildOpenzooModelDefinition();
const requireRecord = createRequireRecord("record", "expected-label-record");

type ProxyState = {
  reachable: boolean;
  identity?: string;
  infoStatus?: number;
  models?: unknown[];
  modelsStatus?: number;
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeProxyModel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    pricing: { prompt: 0.000003, completion: 0.000015 },
    context_length: 128000000,
    top_provider: { context_length: 128000000, max_completion_tokens: 8192 },
    ...overrides,
  };
}

function installProxy(state: ProxyState) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockReset();
  fetchWithSsrFGuardMock.mockImplementation(async (params: { url: string }) => {
    if (!state.reachable) {
      throw new Error("connection refused");
    }
    if (params.url.endsWith("/info")) {
      return {
        response: jsonResponse(
          { youAreTalkingTo: state.identity ?? "openzoo proxy", yourEndpoint: DEFAULT_BASE_URL },
          state.infoStatus ?? 200,
        ),
        release,
      };
    }
    if (params.url.endsWith("/models")) {
      return {
        response: jsonResponse(
          {
            object: "list",
            data: state.models ?? [
              makeProxyModel("auto", { pricing: { prompt: 1e-7, completion: 2e-7 } }),
              makeProxyModel("anthropic/claude-sonnet-5"),
            ],
          },
          state.modelsStatus ?? 200,
        ),
        release,
      };
    }
    throw new Error(`unexpected url ${params.url}`);
  });
  return release;
}

function buildConfig(
  provider?: Partial<import("openclaw/plugin-sdk/provider-model-shared").ModelProviderConfig>,
  config: Omit<OpenClawConfig, "models"> = {},
): OpenClawConfig {
  if (!provider) {
    return { ...config };
  }
  return {
    ...config,
    models: {
      providers: {
        openzoo: {
          baseUrl: DEFAULT_BASE_URL,
          api: "openai-completions",
          models: [],
          ...provider,
        },
      },
    },
  };
}

function buildDiscoveryContext(params?: {
  config?: OpenClawConfig;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderCatalogContext {
  return {
    config: params?.config ?? {},
    env: params?.env ?? {},
    resolveProviderApiKey: () => ({ apiKey: params?.apiKey }),
    resolveProviderAuth: () => ({
      apiKey: params?.apiKey,
      mode: "none" as const,
      source: "none" as const,
    }),
  };
}

function buildNonInteractiveContext(params?: {
  config?: OpenClawConfig;
  customBaseUrl?: string;
  customModelId?: string;
}) {
  const runtime = createNonExitingRuntimeEnv();
  return {
    authChoice: "openzoo",
    config: params?.config ?? {},
    baseConfig: params?.config ?? {},
    opts: {
      customBaseUrl: params?.customBaseUrl,
      customModelId: params?.customModelId,
    } as ProviderAuthMethodNonInteractiveContext["opts"],
    runtime,
    resolveApiKey: vi.fn(async () => null),
    toApiKeyCredential: vi.fn(),
  } satisfies ProviderAuthMethodNonInteractiveContext;
}

function requireOpenzooProvider(config: OpenClawConfig | null | undefined) {
  const provider = config?.models?.providers?.openzoo;
  if (!provider) {
    throw new Error("expected openzoo provider config");
  }
  return provider;
}

beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

describe("fetchOpenzooInfo", () => {
  it("probes /info with a short local timeout and recognizes the proxy", async () => {
    installProxy({ reachable: true });

    const probe = await fetchOpenzooInfo({ baseUrl: DEFAULT_BASE_URL });

    expect(probe.reachable).toBe(true);
    const [guardedFetchParams] = fetchWithSsrFGuardMock.mock.calls[0] ?? [];
    const guardedFetch = requireRecord(guardedFetchParams, "guarded fetch params");
    expect(guardedFetch.url).toBe(`${DEFAULT_BASE_URL}/info`);
    expect(guardedFetch.timeoutMs).toBeLessThanOrEqual(2000);
    expect(guardedFetch.policy).toEqual({ allowedHostnames: ["localhost"] });
    expect(guardedFetch.auditContext).toBe("openzoo.info_probe");
  });

  it("treats other servers, HTTP errors, and network failures as unreachable", async () => {
    installProxy({ reachable: true, identity: "some other proxy" });
    expect((await fetchOpenzooInfo({ baseUrl: DEFAULT_BASE_URL })).reachable).toBe(false);

    const release = installProxy({ reachable: true, infoStatus: 503 });
    expect(await fetchOpenzooInfo({ baseUrl: DEFAULT_BASE_URL })).toEqual({
      reachable: false,
      status: 503,
    });
    expect(release).toHaveBeenCalledOnce();

    installProxy({ reachable: false });
    expect((await fetchOpenzooInfo({ baseUrl: DEFAULT_BASE_URL })).reachable).toBe(false);
  });
});

describe("discoverOpenzooProvider", () => {
  it("returns null when the proxy is down and nothing is configured", async () => {
    installProxy({ reachable: false });

    expect(await discoverOpenzooProvider(buildDiscoveryContext())).toBeNull();
  });

  it("falls back to the static catalog when the proxy is down but configured", async () => {
    installProxy({ reachable: false });

    const result = await discoverOpenzooProvider(
      buildDiscoveryContext({ config: buildConfig({}) }),
    );

    expect(result?.provider).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      api: "openai-completions",
      apiKey: OPENZOO_LOCAL_API_KEY_PLACEHOLDER,
      models: [STATIC_AUTO],
    });
  });

  it("publishes the discovered priced catalog with the local marker when the proxy answers", async () => {
    installProxy({ reachable: true });

    const result = await discoverOpenzooProvider(buildDiscoveryContext());

    expect(result?.provider.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(result?.provider.apiKey).toBe(OPENZOO_LOCAL_API_KEY_PLACEHOLDER);
    expect(result?.provider).not.toHaveProperty("auth");
    expect(result?.provider.models.map((model) => model.id)).toEqual([
      "auto",
      "anthropic/claude-sonnet-5",
    ]);
    expect(result?.provider.models[1]?.cost.input).toBeCloseTo(3);
  });

  it("keeps explicit rows authoritative and appends discovered rows", async () => {
    installProxy({ reachable: true });
    const pinned: ModelDefinitionConfig = { ...STATIC_AUTO, name: "Zoo router" };

    const result = await discoverOpenzooProvider(
      buildDiscoveryContext({ config: buildConfig({ models: [pinned] }) }),
    );

    expect(result?.provider.models[0]).toEqual(pinned);
    expect(result?.provider.models.map((model) => model.id)).toEqual([
      "auto",
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("uses the configured base URL, then OPENZOO_BASE_URL, for discovery", async () => {
    installProxy({ reachable: true });
    await discoverOpenzooProvider(
      buildDiscoveryContext({
        config: buildConfig({ baseUrl: "http://proxy-host:8402" }),
        env: { OPENZOO_BASE_URL: "http://ignored:1/v1" },
      }),
    );
    expect(
      fetchWithSsrFGuardMock.mock.calls.map((call) => requireRecord(call[0], "call").url),
    ).toEqual(["http://proxy-host:8402/v1/info", "http://proxy-host:8402/v1/models"]);

    installProxy({ reachable: true });
    const result = await discoverOpenzooProvider(
      buildDiscoveryContext({ env: { OPENZOO_BASE_URL: "http://env-host:9402/v1" } }),
    );
    expect(result?.provider.baseUrl).toBe("http://env-host:9402/v1");
  });

  it("preserves a real operator credential and downgrades synthetic markers", async () => {
    installProxy({ reachable: true });
    const real = await discoverOpenzooProvider(
      buildDiscoveryContext({ config: buildConfig({ apiKey: "real-key" }), apiKey: "real-key" }),
    );
    expect(real?.provider).toMatchObject({ auth: "api-key", apiKey: "real-key" });

    installProxy({ reachable: true });
    const synthetic = await discoverOpenzooProvider(
      buildDiscoveryContext({ apiKey: CUSTOM_LOCAL_AUTH_MARKER }),
    );
    expect(synthetic?.provider.apiKey).toBe(OPENZOO_LOCAL_API_KEY_PLACEHOLDER);
  });
});

describe("mergeOpenzooModels and default selection", () => {
  it("dedupes by id with explicit rows first", () => {
    const explicit: ModelDefinitionConfig = { ...STATIC_AUTO, name: "pinned" };
    const discovered = [STATIC_AUTO, { ...STATIC_AUTO, id: "x-ai/grok-4.6" }];
    expect(mergeOpenzooModels([explicit], discovered).map((model) => model.name)).toEqual([
      "pinned",
      "auto",
    ]);
    expect(mergeOpenzooModels(undefined, discovered)).toEqual(discovered);
  });

  it("prefers auto, then the first row, and validates requested ids", () => {
    const other = { ...STATIC_AUTO, id: "x-ai/grok-4.6" };
    expect(selectOpenzooDefaultModelRef([other, STATIC_AUTO])).toBe("openzoo/auto");
    expect(selectOpenzooDefaultModelRef([other])).toBe("openzoo/x-ai/grok-4.6");
    expect(selectOpenzooDefaultModelRef([])).toBeUndefined();
    expect(selectOpenzooDefaultModelRef([other, STATIC_AUTO], "x-ai/grok-4.6")).toBe(
      "openzoo/x-ai/grok-4.6",
    );
    expect(selectOpenzooDefaultModelRef([STATIC_AUTO], "missing/model")).toBeUndefined();
  });
});

describe("promptAndConfigureOpenzooInteractive", () => {
  it("confirms the proxy and seeds config with the static catalog", async () => {
    installProxy({ reachable: true });
    const { prompter, text, note } = createQueuedWizardPrompter({ textValues: [""] });

    const result = await promptAndConfigureOpenzooInteractive({
      config: {},
      env: {},
      prompter,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: DEFAULT_BASE_URL, placeholder: DEFAULT_BASE_URL }),
    );
    expect(note).not.toHaveBeenCalled();
    expect(result.profiles).toEqual([]);
    expect(result.defaultModel).toBe("openzoo/auto");
    expect(result.configPatch?.models).toEqual({
      mode: "merge",
      providers: {
        openzoo: {
          baseUrl: DEFAULT_BASE_URL,
          api: "openai-completions",
          apiKey: OPENZOO_LOCAL_API_KEY_PLACEHOLDER,
          models: [STATIC_AUTO],
        },
      },
    });
    expect(result.configPatch?.agents?.defaults?.models).toEqual({
      "openzoo/auto": { alias: "openzoo" },
    });
  });

  it("normalizes a typed base URL and keeps an existing real credential", async () => {
    installProxy({ reachable: true });
    const { prompter } = createQueuedWizardPrompter({ textValues: ["http://proxy-host:9402"] });

    const result = await promptAndConfigureOpenzooInteractive({
      config: buildConfig({ apiKey: "real-key", headers: { "X-Proxy-Auth": "1" } }),
      env: {},
      prompter,
    });

    expect(requireOpenzooProvider(result.configPatch as OpenClawConfig)).toEqual({
      baseUrl: "http://proxy-host:9402/v1",
      api: "openai-completions",
      auth: "api-key",
      apiKey: "real-key",
      headers: { "X-Proxy-Auth": "1" },
      models: [STATIC_AUTO],
    });
  });

  it("prints the npx openzoo hint and cancels when the proxy stays down", async () => {
    installProxy({ reachable: false });
    const { prompter, note, confirm } = createQueuedWizardPrompter({
      textValues: [""],
      confirmValues: [false],
    });

    await expect(
      promptAndConfigureOpenzooInteractive({ config: {}, env: {}, prompter }),
    ).rejects.toThrow("openzoo proxy not reachable");

    expect(note).toHaveBeenCalledWith(
      `openzoo proxy could not be reached at ${DEFAULT_BASE_URL}.\nStart it in another terminal with \`npx openzoo\` (it prints a funding address; fund it with USDC on Solana or Base), then retry.`,
      "openzoo",
    );
    expect(confirm).toHaveBeenCalledWith({
      message: "Retry the openzoo proxy connection now?",
      initialValue: true,
    });
  });

  it("retries the probe after the proxy comes up", async () => {
    let attempts = 0;
    fetchWithSsrFGuardMock.mockImplementation(async (params: { url: string }) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("connection refused");
      }
      const payload = params.url.endsWith("/info")
        ? { youAreTalkingTo: "openzoo proxy" }
        : { data: [makeProxyModel("auto", { pricing: { prompt: 1e-7, completion: 2e-7 } })] };
      return { response: jsonResponse(payload), release: async () => {} };
    });
    const { prompter, confirm } = createQueuedWizardPrompter({
      textValues: [""],
      confirmValues: [true],
    });

    const result = await promptAndConfigureOpenzooInteractive({ config: {}, env: {}, prompter });

    expect(confirm).toHaveBeenCalledOnce();
    expect(result.defaultModel).toBe("openzoo/auto");
  });
});

describe("non-interactive setup", () => {
  it("writes the provider and default model when the proxy answers", async () => {
    installProxy({ reachable: true });
    const ctx = buildNonInteractiveContext();

    const result = await configureOpenzooNonInteractive(ctx);

    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe("openzoo/auto");
    expect(requireOpenzooProvider(result)).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      api: "openai-completions",
      apiKey: OPENZOO_LOCAL_API_KEY_PLACEHOLDER,
      models: [STATIC_AUTO],
    });
    expect(result?.models?.mode).toBe("merge");
    expect(result?.agents?.defaults?.models).toEqual({ "openzoo/auto": { alias: "openzoo" } });
    expect(ctx.runtime.error).not.toHaveBeenCalled();
  });

  it("honours --custom-base-url and --custom-model-id", async () => {
    installProxy({ reachable: true });
    const ctx = buildNonInteractiveContext({
      customBaseUrl: "http://proxy-host:8402",
      customModelId: "anthropic/claude-sonnet-5",
    });

    const result = await configureOpenzooNonInteractive(ctx);

    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "openzoo/anthropic/claude-sonnet-5",
    );
    expect(requireOpenzooProvider(result).baseUrl).toBe("http://proxy-host:8402/v1");
  });

  it("fails closed with the setup hint when the proxy is down", async () => {
    installProxy({ reachable: false });
    const ctx = buildNonInteractiveContext();

    expect(await configureOpenzooNonInteractive(ctx)).toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Start it in another terminal with `npx openzoo`"),
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects a requested model the proxy does not list", async () => {
    installProxy({ reachable: true });
    const ctx = buildNonInteractiveContext({ customModelId: "missing/model" });

    expect(await configureOpenzooNonInteractive(ctx)).toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("openzoo model missing/model was not found"),
    );
  });

  it("validates without mutating config", async () => {
    installProxy({ reachable: true });
    expect(await validateOpenzooNonInteractive(buildNonInteractiveContext())).toBe(true);

    installProxy({ reachable: false });
    const ctx = buildNonInteractiveContext();
    expect(await validateOpenzooNonInteractive(ctx)).toBe(false);
    expect(ctx.runtime.error).toHaveBeenCalledOnce();
  });
});

describe("app-guided setup", () => {
  it("reports availability from the info probe", async () => {
    installProxy({ reachable: true });
    expect(await detectAppGuidedOpenzooAvailability({ config: {}, env: {} })).toBe(true);

    installProxy({ reachable: false });
    expect(await detectAppGuidedOpenzooAvailability({ config: {}, env: {} })).toBe(false);
  });

  it("offers the router row when the proxy answers", async () => {
    installProxy({ reachable: true });
    expect(await detectAppGuidedOpenzooModel({ config: {}, env: {} })).toEqual({
      modelRef: "openzoo/auto",
      detail: `auto at ${DEFAULT_BASE_URL}`,
    });

    installProxy({ reachable: false });
    expect(await detectAppGuidedOpenzooModel({ config: {}, env: {} })).toBeNull();
  });

  it("prepares config for a detected model and rejects foreign refs", async () => {
    installProxy({ reachable: true });
    const prepared = await prepareAppGuidedOpenzooSetup({
      config: {},
      env: {},
      modelRef: "openzoo/anthropic/claude-sonnet-5",
    });
    expect(prepared?.defaultModel).toBe("openzoo/anthropic/claude-sonnet-5");
    expect(requireOpenzooProvider(prepared?.configPatch as OpenClawConfig).apiKey).toBe(
      OPENZOO_LOCAL_API_KEY_PLACEHOLDER,
    );

    installProxy({ reachable: true });
    expect(
      await prepareAppGuidedOpenzooSetup({ config: {}, env: {}, modelRef: "lmstudio/qwen" }),
    ).toBeNull();

    installProxy({ reachable: true });
    expect(
      await prepareAppGuidedOpenzooSetup({ config: {}, env: {}, modelRef: "openzoo/missing" }),
    ).toBeNull();

    installProxy({ reachable: false });
    expect(
      await prepareAppGuidedOpenzooSetup({ config: {}, env: {}, modelRef: "openzoo/auto" }),
    ).toBeNull();
  });
});
