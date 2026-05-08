import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listOpenAIAuthProfileProvidersForAgentRuntime,
  modelSelectionShouldEnsureCodexPlugin,
  openAIProviderUsesCodexRuntimeByDefault,
  resolveOpenAIRuntimeProviderForPi,
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

  it("ignores session PI pins when validating OpenAI auth profiles", () => {
    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "codex",
      }),
    ).toEqual(["openai-codex"]);
  });
});
