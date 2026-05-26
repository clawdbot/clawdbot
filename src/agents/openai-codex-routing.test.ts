import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listOpenAIAuthProfileProvidersForAgentRuntime,
  modelSelectionShouldEnsureCodexPlugin,
  openAIProviderUsesCodexRuntimeByDefault,
  resolveOpenAICompactionRuntimeProvider,
  resolveOpenAIRuntimeProviderForPi,
  resolveSelectedOpenAIPiRuntimeProvider,
} from "./openai-codex-routing.js";

describe("OpenAI Codex routing policy", () => {
  it("uses Codex by default for official OpenAI agent model selections", () => {
    expect(openAIProviderUsesCodexRuntimeByDefault({ provider: "openai" })).toBe(true);
    expect(
      modelSelectionShouldEnsureCodexPlugin({
        model: "openai/gpt-5.5",
        config: {} as OpenClawConfig,
      }),
    ).toBe(true);
  });

  it("does not force Codex for custom OpenAI-compatible base URLs", () => {
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

    expect(openAIProviderUsesCodexRuntimeByDefault({ provider: "openai", config })).toBe(false);
    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(false);
  });

  it("maps explicit PI plus Codex auth profile to the legacy PI Codex-auth transport", () => {
    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "pi",
      }),
    ).toEqual(["openai", "openai-codex"]);
    expect(
      resolveOpenAIRuntimeProviderForPi({
        provider: "openai",
        harnessRuntime: "pi",
        authProfileProvider: "openai-codex",
        authProfileId: "openai-codex:work",
      }),
    ).toBe("openai-codex");
  });

  it("keeps explicit OpenAI PI Codex auth order ahead of API-key backups", () => {
    const config = {
      auth: {
        order: {
          openai: ["openai-codex:work", "openai:backup"],
        },
      },
    } satisfies OpenClawConfig;

    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "pi",
        config,
      }),
    ).toEqual(["openai-codex", "openai"]);
    expect(
      resolveSelectedOpenAIPiRuntimeProvider({
        provider: "openai",
        harnessRuntime: "pi",
        config,
      }),
    ).toBe("openai-codex");
    expect(
      resolveOpenAIRuntimeProviderForPi({
        provider: "openai",
        harnessRuntime: "pi",
        config,
      }),
    ).toBe("openai");
  });

  it("keeps explicit OpenAI PI API-key auth order ahead of Codex backups", () => {
    const config = {
      auth: {
        order: {
          openai: ["openai:backup", "openai-codex:work"],
        },
      },
    } satisfies OpenClawConfig;

    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "pi",
        config,
      }),
    ).toEqual(["openai", "openai-codex"]);
    expect(
      resolveSelectedOpenAIPiRuntimeProvider({
        provider: "openai",
        harnessRuntime: "pi",
        config,
      }),
    ).toBe("openai");
  });

  it("does not route custom OpenAI-compatible PI configs through Codex auth order", () => {
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
          openai: ["openai-codex:work", "openai:backup"],
        },
      },
    } satisfies OpenClawConfig;

    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "pi",
        config,
      }),
    ).toEqual(["openai", "openai-codex"]);
    expect(
      resolveSelectedOpenAIPiRuntimeProvider({
        provider: "openai",
        harnessRuntime: "pi",
        config,
      }),
    ).toBe("openai");
  });

  it("validates Codex harness auth through the Codex provider contract", () => {
    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "codex",
      }),
    ).toEqual(["openai-codex"]);
  });

  it("routes selected OpenAI Codex runtime through OpenAI-Codex even before auth is configured", () => {
    expect(
      resolveSelectedOpenAIPiRuntimeProvider({
        provider: "openai",
        harnessRuntime: "codex",
      }),
    ).toBe("openai-codex");
  });

  it("routes OpenAI compaction to OpenAI-Codex when Codex auth order is configured", () => {
    expect(
      resolveOpenAICompactionRuntimeProvider({
        provider: "openai",
        harnessRuntime: "codex",
        config: {
          auth: {
            order: {
              "openai-codex": ["openai-codex:work"],
            },
          },
        },
      }),
    ).toBe("openai-codex");
  });

  it("routes OpenAI compaction to OpenAI-Codex when a Codex auth profile is configured", () => {
    expect(
      resolveOpenAICompactionRuntimeProvider({
        provider: "openai",
        harnessRuntime: "codex",
        config: {
          auth: {
            profiles: {
              work: {
                provider: "openai-codex",
                mode: "oauth",
              },
            },
          },
        },
      }),
    ).toBe("openai-codex");
  });

  it("routes OpenAI compaction to OpenAI-Codex when OpenAI auth order selects Codex", () => {
    const config = {
      auth: {
        order: {
          openai: ["openai-codex:work"],
        },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveOpenAICompactionRuntimeProvider({
        provider: "openai",
        harnessRuntime: "codex",
        config,
      }),
    ).toBe("openai-codex");
  });

  it("keeps OpenAI compaction on OpenAI when only direct API-key auth is implied", () => {
    expect(
      resolveOpenAICompactionRuntimeProvider({
        provider: "openai",
        harnessRuntime: "codex",
      }),
    ).toBe("openai");
  });

  it("does not route non-OpenAI providers when runtime is codex", () => {
    expect(
      resolveSelectedOpenAIPiRuntimeProvider({
        provider: "anthropic",
        harnessRuntime: "codex",
      }),
    ).toBe("anthropic");
  });
});
