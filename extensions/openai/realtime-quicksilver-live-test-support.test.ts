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

  it("uses the selected provider model when the Talk-level model is not eligible", () => {
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

    expect(resolveConfiguredLiveQuicksilverModel()).toBe("gpt-live-provider-fixture");
  });

  it("uses a sole provider model when no provider is selected", () => {
    mocks.getRuntimeConfig.mockReturnValue({
      talk: {
        realtime: {
          providers: {
            custom: { model: "gpt-live-provider-fixture" },
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
  ])("rejects missing or ineligible live configuration", (config) => {
    mocks.getRuntimeConfig.mockReturnValue(config);

    expect(resolveConfiguredLiveQuicksilverModel()).toBeUndefined();
  });
});
