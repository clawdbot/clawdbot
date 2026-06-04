// Covers provider setup wizard prompts supplied by plugins.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  resolveProviderPluginChoice,
  resolveProviderWizardOptions,
  runProviderModelSelectedHook,
} from "./provider-wizard.js";
import type { ProviderPlugin } from "./types.js";

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
vi.mock("./providers.runtime.js", () => ({
  isPluginProvidersLoadInFlight: () => false,
  resolvePluginProviders,
}));

const DEFAULT_WORKSPACE_DIR = "/tmp/workspace";

function makeProvider(overrides: Partial<ProviderPlugin> & Pick<ProviderPlugin, "id" | "label">) {
  return {
    auth: [],
    ...overrides,
  } satisfies ProviderPlugin;
}

function createSglangWizardProvider(params?: {
  includeSetup?: boolean;
  includeModelPicker?: boolean;
}) {
  return makeProvider({
    id: "sglang",
    label: "SGLang",
    auth: [{ id: "server", label: "Server", kind: "custom", run: vi.fn() }],
    wizard: {
      ...((params?.includeSetup ?? true)
        ? {
            setup: {
              choiceLabel: "SGLang setup",
              groupId: "sglang",
              groupLabel: "SGLang",
            },
          }
        : {}),
      ...(params?.includeModelPicker
        ? {
            modelPicker: {
              label: "SGLang server",
              methodId: "server",
            },
          }
        : {}),
    },
  });
}

function createSglangConfig() {
  return {
    plugins: {
      allow: ["sglang"],
    },
  };
}

function createHomeEnv(suffix = "", overrides?: Partial<NodeJS.ProcessEnv>) {
  return {
    OPENCLAW_HOME: `/tmp/openclaw-home${suffix}`,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function createWizardRuntimeParams(params?: {
  config?: object;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}) {
  return {
    config: params?.config ?? createSglangConfig(),
    workspaceDir: params?.workspaceDir ?? DEFAULT_WORKSPACE_DIR,
    env: params?.env ?? createHomeEnv(),
  };
}

function expectProviderResolutionCall(params?: {
  config?: object;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  count?: number;
}) {
  expect(resolvePluginProviders).toHaveBeenCalledTimes(params?.count ?? 1);
  expect(resolvePluginProviders).toHaveBeenCalledWith({
    ...createWizardRuntimeParams(params),
    mode: "setup",
  });
}

function setResolvedProviders(...providers: ProviderPlugin[]) {
  resolvePluginProviders.mockReturnValue(providers);
}

function expectSingleWizardChoice(params: {
  provider: ProviderPlugin;
  choice: string;
  expectedOption: Record<string, unknown>;
  expectedWizard: unknown;
}) {
  setResolvedProviders(params.provider);
  expect(resolveProviderWizardOptions({})).toEqual([params.expectedOption]);
  expect(
    resolveProviderPluginChoice({
      providers: [params.provider],
      choice: params.choice,
    }),
  ).toEqual({
    provider: params.provider,
    method: params.provider.auth[0],
    wizard: params.expectedWizard,
  });
}

function expectModelPickerEntries(
  provider: ProviderPlugin,
  expected: Array<{
    value: string;
    label: string;
    hint?: string;
  }>,
) {
  setResolvedProviders(provider);
  expect(resolveProviderModelPickerEntries({})).toEqual(expected);
}

describe("provider wizard boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it.each([
    {
      name: "uses explicit setup choice ids and bound method ids",
      provider: makeProvider({
        id: "vllm",
        label: "vLLM",
        auth: [
          { id: "local", label: "Local", kind: "custom", run: vi.fn() },
          { id: "cloud", label: "Cloud", kind: "custom", run: vi.fn() },
        ],
        wizard: {
          setup: {
            choiceId: "self-hosted-vllm",
            methodId: "local",
            choiceLabel: "vLLM local",
            groupId: "local-runtimes",
            groupLabel: "Local runtimes",
          },
        },
      }),
      choice: "self-hosted-vllm",
      expectedOption: {
        value: "self-hosted-vllm",
        label: "vLLM local",
        groupId: "local-runtimes",
        groupLabel: "Local runtimes",
      },
      resolveWizard: (provider: ProviderPlugin) => provider.wizard?.setup,
    },
    {
      name: "builds wizard options from method-level metadata",
      provider: makeProvider({
        id: "openai",
        label: "OpenAI",
        auth: [
          {
            id: "api-key",
            label: "OpenAI API key",
            kind: "api_key",
            wizard: {
              choiceId: "openai-api-key",
              choiceLabel: "OpenAI API key",
              groupId: "openai",
              groupLabel: "OpenAI",
              onboardingScopes: ["text-inference"],
            },
            run: vi.fn(),
          },
        ],
      }),
      choice: "openai-api-key",
      expectedOption: {
        value: "openai-api-key",
        label: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
        onboardingScopes: ["text-inference"],
      },
      resolveWizard: (provider: ProviderPlugin) => provider.auth[0]?.wizard,
    },
    {
      name: "preserves onboarding scopes on wizard options",
      provider: makeProvider({
        id: "fal",
        label: "fal",
        auth: [
          {
            id: "api-key",
            label: "fal API key",
            kind: "api_key",
            wizard: {
              choiceId: "fal-api-key",
              choiceLabel: "fal API key",
              groupId: "fal",
              groupLabel: "fal",
              onboardingScopes: ["image-generation"],
            },
            run: vi.fn(),
          },
        ],
      }),
      choice: "fal-api-key",
      expectedOption: {
        value: "fal-api-key",
        label: "fal API key",
        groupId: "fal",
        groupLabel: "fal",
        onboardingScopes: ["image-generation"],
      },
      resolveWizard: (provider: ProviderPlugin) => provider.auth[0]?.wizard,
    },
    {
      name: "returns method wizard metadata for canonical choices",
      provider: makeProvider({
        id: "anthropic",
        label: "Anthropic",
        auth: [
          {
            id: "cli",
            label: "Claude CLI",
            kind: "custom",
            wizard: {
              choiceId: "anthropic-cli",
              modelAllowlist: {
                allowedKeys: ["claude-cli/claude-sonnet-4-6"],
                initialSelections: ["claude-cli/claude-sonnet-4-6"],
                message: "Claude CLI models",
              },
            },
            run: vi.fn(),
          },
        ],
      }),
      choice: "anthropic-cli",
      expectedOption: {
        value: "anthropic-cli",
        label: "Anthropic",
        groupId: "anthropic",
        groupLabel: "Anthropic",
        groupHint: undefined,
        hint: undefined,
      },
      resolveWizard: (provider: ProviderPlugin) => provider.auth[0]?.wizard,
    },
  ] as const)("$name", ({ provider, choice, expectedOption, resolveWizard }) => {
    expectSingleWizardChoice({
      provider,
      choice,
      expectedOption,
      expectedWizard: resolveWizard(provider),
    });
  });

  it("builds model-picker entries from plugin metadata and provider-method choices", () => {
    const provider = makeProvider({
      id: "sglang",
      label: "SGLang",
      auth: [
        { id: "server", label: "Server", kind: "custom", run: vi.fn() },
        { id: "cloud", label: "Cloud", kind: "custom", run: vi.fn() },
      ],
      wizard: {
        modelPicker: {
          label: "SGLang server",
          hint: "OpenAI-compatible local runtime",
          methodId: "server",
        },
      },
    });
    expectModelPickerEntries(provider, [
      {
        value: buildProviderPluginMethodChoice("sglang", "server"),
        label: "SGLang server",
        hint: "OpenAI-compatible local runtime",
      },
    ]);
  });

  it("resolves providers in setup mode across wizard consumers", () => {
    const provider = createSglangWizardProvider({ includeModelPicker: true });
    const config = {};
    const env = createHomeEnv();
    setResolvedProviders(provider);

    const runtimeParams = createWizardRuntimeParams({ config, env });
    expect(resolveProviderWizardOptions(runtimeParams)).toHaveLength(1);
    expect(resolveProviderModelPickerEntries(runtimeParams)).toHaveLength(1);

    expectProviderResolutionCall({ config, env, count: 2 });
  });

  it("routes model-selected hooks only to the matching provider", async () => {
    const matchingHook = vi.fn(async () => {});
    const otherHook = vi.fn(async () => {});
    setResolvedProviders(
      makeProvider({
        id: "ollama",
        label: "Ollama",
        onModelSelected: otherHook,
      }),
      makeProvider({
        id: "vllm",
        label: "vLLM",
        onModelSelected: matchingHook,
      }),
    );

    const env = createHomeEnv();
    await runProviderModelSelectedHook({
      config: {},
      model: "vllm/qwen3-coder",
      prompter: {} as never,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      env,
    });

    expectProviderResolutionCall({
      config: {},
      env,
    });
    expect(matchingHook).toHaveBeenCalledWith({
      config: {},
      model: "vllm/qwen3-coder",
      prompter: {},
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });
    expect(otherHook).not.toHaveBeenCalled();
  });
});
