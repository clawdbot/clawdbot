// Verifies OpenAI model selections route between OpenClaw and Codex runtimes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listOpenAIAuthProfileProvidersForAgentRuntime,
  modelSelectionShouldEnsureCodexPlugin,
  resolveOpenAIImplicitAgentRuntime,
  resolveContextConfigProviderForRuntime,
  resolveOpenAIRuntimeProvider,
  resolveSelectedOpenAIRuntimeProvider,
} from "./openai-routing.js";

describe("OpenAI runtime routing policy", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_BASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses Codex by default for official OpenAI agent model selections", () => {
    expect(resolveOpenAIImplicitAgentRuntime({ provider: "openai", env: {} })).toBe("codex");
    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        modelId: "gpt-5.4-nano",
        env: {},
      }),
    ).toBe("codex");
    expect(
      modelSelectionShouldEnsureCodexPlugin({
        model: "openai/gpt-5.5",
        config: {} as OpenClawConfig,
      }),
    ).toBe(true);
  });

  it("maps provider route facts onto a closed implicit runtime", () => {
    expect(
      resolveOpenAIImplicitAgentRuntime({ provider: "openai", modelId: "gpt-5.6", env: {} }),
    ).toBe("codex");
    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
        env: {},
      }),
    ).toBe("codex");
    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        modelId: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: {
                api: "openai-completions",
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        },
        env: {},
      }),
    ).toBe("openclaw");
    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        baseUrl: "https://direct.example.test/v1",
        env: {},
      }),
    ).toBe("openclaw");
  });

  it("lets the provider owner interpret its environment", () => {
    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        env: { OPENAI_BASE_URL: "https://relay.example.test/v1" },
      }),
    ).toBe("openclaw");
  });

  it("fails closed to OpenClaw when the provider artifact is unavailable", () => {
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    expect(resolveOpenAIImplicitAgentRuntime({ provider: "openai", modelId: "gpt-5.5" })).toBe(
      "openclaw",
    );
    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5" })).toBe(false);
  });

  it("does not force Codex for custom OpenAI-compatible base URLs", () => {
    // A custom baseUrl means the provider key is only OpenAI-compatible, not official OpenAI.
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://example.test/v1",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveOpenAIImplicitAgentRuntime({ provider: "openai", config })).toBe("openclaw");
    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(false);
    expect(
      resolveContextConfigProviderForRuntime({
        provider: "openai",
        runtimeId: "codex",
        config,
      }),
    ).toBe("openai");
  });

  it("honors explicit model runtime policy before the OpenAI base URL default", () => {
    const customCodexConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://example.test/v1",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const officialOpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      modelSelectionShouldEnsureCodexPlugin({
        model: "openai/gpt-5.5",
        config: customCodexConfig,
      }),
    ).toBe(true);
    expect(
      modelSelectionShouldEnsureCodexPlugin({
        model: "openai/gpt-5.5",
        config: officialOpenClawConfig,
      }),
    ).toBe(false);
  });

  it("honors the deprecated whole-agent OpenClaw runtime opt-out", () => {
    const config = {
      agents: {
        defaults: { agentRuntime: { id: "openclaw" } },
        list: [{ id: "worker", agentRuntime: { id: "openclaw" } }],
      },
    } satisfies OpenClawConfig;

    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(false);
    expect(
      modelSelectionShouldEnsureCodexPlugin({
        model: "openai/gpt-5.5",
        config,
        agentId: "worker",
      }),
    ).toBe(false);
  });

  it("keeps per-model Codex policy above the whole-agent OpenClaw opt-out", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "openclaw" },
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(true);
  });

  it("keeps per-model auto policy above the whole-agent OpenClaw opt-out", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "openclaw" },
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "auto" } },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(true);
  });

  it("normalizes OpenAI provider keys before checking custom base URLs", () => {
    const config = {
      models: {
        providers: {
          OpenAI: {
            baseUrl: "https://example.test/v1",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveOpenAIImplicitAgentRuntime({ provider: "openai", config })).toBe("openclaw");
    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(false);
  });

  it("uses canonical OpenAI context config under the Codex runtime", () => {
    expect(
      resolveContextConfigProviderForRuntime({
        provider: "openai",
        runtimeId: "codex",
      }),
    ).toBe("openai");
  });

  it("uses legacy Codex context config when canonical OpenAI config is absent", () => {
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://chatgpt.com/backend-api/codex",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveContextConfigProviderForRuntime({
        provider: "openai",
        runtimeId: "codex",
        config,
      }),
    ).toBe("openai");
  });

  it("keeps explicit OpenClaw plus Codex auth profile under the unified OpenAI provider", () => {
    // OpenAI auth now stays canonical even when the runtime is not Codex.
    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "openclaw",
      }),
    ).toEqual(["openai"]);
    expect(
      resolveOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "openclaw",
        authProfileProvider: "openai",
        authProfileId: "openai:work",
      }),
    ).toBe("openai");
  });

  it("keeps legacy Codex auth order under the canonical OpenAI provider", () => {
    const config = {
      auth: {
        order: {
          openai: ["openai:work", "openai:backup"],
        },
      },
    } satisfies OpenClawConfig;

    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "openclaw",
        config,
      }),
    ).toEqual(["openai"]);
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "openclaw",
        config,
      }),
    ).toBe("openai");
    expect(
      resolveOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "openclaw",
        config,
      }),
    ).toBe("openai");
  });

  it("checks legacy Codex auth before canonical OpenAI for pre-doctor state", () => {
    const config = {
      auth: {
        order: {
          openai: ["openai:work", "openai:backup"],
        },
      },
    } satisfies OpenClawConfig;

    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "openclaw",
        config,
      }),
    ).toEqual(["openai"]);
  });

  it("keeps explicit OpenAI OpenClaw API-key auth order ahead of Codex backups", () => {
    const config = {
      auth: {
        order: {
          openai: ["openai:backup", "openai:work"],
        },
      },
    } satisfies OpenClawConfig;

    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "openclaw",
        config,
      }),
    ).toEqual(["openai"]);
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "openclaw",
        config,
      }),
    ).toBe("openai");
  });

  it("does not route custom OpenAI-compatible OpenClaw configs through Codex auth order", () => {
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.test/v1",
            models: [],
          },
        },
      },
      auth: {
        order: {
          openai: ["openai:work", "openai:backup"],
        },
      },
    } satisfies OpenClawConfig;

    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "openclaw",
        config,
      }),
    ).toEqual(["openai"]);
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "openclaw",
        config,
      }),
    ).toBe("openai");
  });

  it("validates Codex harness auth through the unified OpenAI provider contract", () => {
    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "codex",
      }),
    ).toEqual(["openai"]);
  });

  it("keeps OpenAI as the runtime provider when harness runtime is codex", () => {
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "codex",
      }),
    ).toBe("openai");
  });

  it("does not route non-OpenAI providers when runtime is codex", () => {
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "anthropic",
        harnessRuntime: "codex",
      }),
    ).toBe("anthropic");
  });
});
