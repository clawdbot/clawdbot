// Qa Lab tests cover model selection plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveEnvApiKey, loadAuthProfileStoreForRuntime, listProfilesForProvider } = vi.hoisted(
  () => ({
    resolveEnvApiKey: vi.fn(),
    loadAuthProfileStoreForRuntime: vi.fn(),
    listProfilesForProvider: vi.fn(),
  }),
);

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveEnvApiKey,
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  loadAuthProfileStoreForRuntime,
  listProfilesForProvider,
}));

import {
  defaultQaRuntimeModelForMode,
  resolveQaRuntimeModelPair,
} from "./model-selection.runtime.js";

describe("qa model selection runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEnvApiKey.mockReturnValue(undefined);
    loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {} });
    listProfilesForProvider.mockImplementation((store: { profiles?: Record<string, unknown> }) =>
      Object.keys(store.profiles ?? {}),
    );
  });

  it("keeps the OpenAI live default when an API key is configured", () => {
    resolveEnvApiKey.mockReturnValue({ apiKey: "sk-test" });

    expect(defaultQaRuntimeModelForMode("live-frontier")).toBe("openai/gpt-5.6");
    expect(resolveQaRuntimeModelPair({ providerMode: "live-frontier" })).toEqual({
      primaryModel: "openai/gpt-5.6",
      alternateModel: "openai/gpt-5.6-luna",
    });
    expect(loadAuthProfileStoreForRuntime).not.toHaveBeenCalled();
  });

  it.each(["oauth", "token"] as const)(
    "prefers the Codex live default for a stored %s profile",
    (type) => {
      loadAuthProfileStoreForRuntime.mockReturnValue({
        profiles: {
          "openai:user@example.com": {
            provider: "openai",
            type,
          },
        },
      });

      expect(resolveQaRuntimeModelPair({ providerMode: "live-frontier" })).toEqual({
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-sol",
      });
      expect(loadAuthProfileStoreForRuntime).toHaveBeenCalledWith(undefined, {
        readOnly: true,
        allowKeychainPrompt: false,
        externalCliProviderIds: ["openai"],
      });
    },
  );

  it("keeps the OpenAI live default when stored OpenAI profiles are available", () => {
    loadAuthProfileStoreForRuntime.mockReturnValue({
      profiles: {
        "openai:api-key": {
          provider: "openai",
          type: "api_key",
        },
      },
    });

    expect(defaultQaRuntimeModelForMode("live-frontier")).toBe("openai/gpt-5.6");
  });

  it.each(["openai/gpt-5.6", "openai/gpt-5.6-sol"])(
    "derives Luna after explicit Sol primary %s",
    (primaryModel) => {
      expect(resolveQaRuntimeModelPair({ providerMode: "live-frontier", primaryModel })).toEqual({
        primaryModel,
        alternateModel: "openai/gpt-5.6-luna",
      });
    },
  );

  it("derives Sol after an explicit Luna primary", () => {
    expect(
      resolveQaRuntimeModelPair({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }),
    ).toEqual({
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-sol",
    });
  });

  it("falls back through the provider default for an unmapped primary", () => {
    expect(
      resolveQaRuntimeModelPair({
        providerMode: "live-frontier",
        primaryModel: "anthropic/claude-sonnet-4-6",
      }),
    ).toEqual({
      primaryModel: "anthropic/claude-sonnet-4-6",
      alternateModel: "openai/gpt-5.6",
    });
  });

  it("preserves an explicit alternate model", () => {
    expect(
      resolveQaRuntimeModelPair({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6",
        alternateModel: "openai/gpt-5.6-terra",
      }),
    ).toEqual({
      primaryModel: "openai/gpt-5.6",
      alternateModel: "openai/gpt-5.6-terra",
    });
  });

  it.each([
    ["openai/gpt-5.4", "openai/gpt-5.4"],
    ["openai/gpt-5.6", "openai/gpt-5.6-sol"],
  ])("preserves the explicit model pair %s / %s", (primaryModel, alternateModel) => {
    expect(
      resolveQaRuntimeModelPair({
        providerMode: "live-frontier",
        primaryModel,
        alternateModel,
      }),
    ).toEqual({ primaryModel, alternateModel });
  });

  it("leaves mock defaults unchanged", () => {
    expect(defaultQaRuntimeModelForMode("mock-openai")).toBe("mock-openai/gpt-5.6-luna");
    expect(defaultQaRuntimeModelForMode("mock-openai", { alternate: true })).toBe(
      "mock-openai/gpt-5.6-luna-alt",
    );
    expect(defaultQaRuntimeModelForMode("aimock")).toBe("aimock/gpt-5.6-luna");
    expect(defaultQaRuntimeModelForMode("aimock", { alternate: true })).toBe(
      "aimock/gpt-5.6-luna-alt",
    );
  });
});
