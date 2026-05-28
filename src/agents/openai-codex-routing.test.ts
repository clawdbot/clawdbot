import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listOpenAIAuthProfileProvidersForAgentRuntime,
  modelSelectionShouldEnsureCodexPlugin,
  openAIProviderUsesCodexRuntimeByDefault,
  resolveOpenAIRuntimeProvider,
  resolveSelectedOpenAIRuntimeProvider,
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

  it("maps explicit OpenClaw plus Codex auth profile to the OpenClaw Codex-auth transport", () => {
    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "openclaw",
      }),
    ).toEqual(["openai", "openai-codex"]);
    expect(
      resolveOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "openclaw",
        authProfileProvider: "openai-codex",
        authProfileId: "openai-codex:work",
      }),
    ).toBe("openai-codex");
  });

  it("keeps explicit OpenAI OpenClaw Codex auth order ahead of API-key backups", () => {
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
        harnessRuntime: "openclaw",
        config,
      }),
    ).toEqual(["openai-codex", "openai"]);
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "openclaw",
        config,
      }),
    ).toBe("openai-codex");
    expect(
      resolveOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "openclaw",
        config,
      }),
    ).toBe("openai");
  });

  it("keeps explicit OpenAI OpenClaw API-key auth order ahead of Codex backups", () => {
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
        harnessRuntime: "openclaw",
        config,
      }),
    ).toEqual(["openai", "openai-codex"]);
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
          openai: ["openai-codex:work", "openai:backup"],
        },
      },
    } satisfies OpenClawConfig;

    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "openclaw",
        config,
      }),
    ).toEqual(["openai", "openai-codex"]);
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "openclaw",
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

  it("routes openai provider to openai-codex when harness runtime is codex", () => {
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "codex",
      }),
    ).toBe("openai-codex");
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
