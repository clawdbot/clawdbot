import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

import { resolveConfiguredLiveQuicksilverModel } from "./realtime-quicksilver-live-test-support.js";

describe("private realtime live model selection", () => {
  beforeEach(() => {
    mocks.getRuntimeConfig.mockReset();
  });

  it("prefers a valid Talk-level model over provider configuration", () => {
    mocks.getRuntimeConfig.mockReturnValue({
      talk: {
        realtime: {
          provider: "openai",
          model: "gpt-live-direct-fixture",
          providers: {
            openai: { model: "gpt-live-provider-fixture" },
          },
        },
      },
    });

    expect(resolveConfiguredLiveQuicksilverModel()).toBe("gpt-live-direct-fixture");
  });

  it("rejects an ineligible explicit Talk-level model instead of falling through", () => {
    mocks.getRuntimeConfig.mockReturnValue({
      talk: {
        realtime: {
          provider: " OPENAI ",
          model: "public-realtime-fixture",
          providers: {
            OpenAI: { model: "gpt-live-provider-fixture" },
          },
        },
      },
    });

    expect(resolveConfiguredLiveQuicksilverModel()).toBeUndefined();
  });

  it("uses a sole OpenAI provider model when no provider is selected", () => {
    mocks.getRuntimeConfig.mockReturnValue({
      talk: {
        realtime: {
          providers: {
            OpenAI: { model: "gpt-live-provider-fixture" },
          },
        },
      },
    });

    expect(resolveConfiguredLiveQuicksilverModel()).toBe("gpt-live-provider-fixture");
  });

  it.each([
    {},
    { talk: { realtime: {} } },
    {
      talk: {
        realtime: {
          provider: "openai",
          model: "public-realtime-fixture",
          providers: { openai: { model: "other-public-fixture" } },
        },
      },
    },
    {
      talk: {
        realtime: {
          provider: "custom",
          model: "gpt-live-direct-fixture",
          providers: { custom: { model: "gpt-live-provider-fixture" } },
        },
      },
    },
    {
      talk: {
        realtime: {
          providers: { custom: { model: "gpt-live-provider-fixture" } },
        },
      },
    },
    {
      talk: {
        realtime: {
          model: "gpt-live-direct-fixture",
          providers: { custom: { model: "gpt-live-provider-fixture" } },
        },
      },
    },
  ])("rejects missing or ineligible live configuration", (config) => {
    mocks.getRuntimeConfig.mockReturnValue(config);

    expect(resolveConfiguredLiveQuicksilverModel()).toBeUndefined();
  });
});
