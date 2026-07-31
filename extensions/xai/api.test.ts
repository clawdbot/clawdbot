// Xai tests cover api plugin behavior.
import { describe, expect, it } from "vitest";
import {
  isXaiModelHint,
  resolveXaiForwardCompatModel,
  resolveXaiTransport,
  XAI_BASE_URL,
} from "./api.js";

describe("xai api helpers", () => {
  it("uses shared endpoint classification for native xAI transports", () => {
    expect(
      resolveXaiTransport({
        provider: "custom-xai",
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
      }),
    ).toEqual({
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it.each([
    ["xai", "openai-completions"],
    ["x-ai", "openai-completions"],
    ["xai", "openai-responses"],
    ["x-ai", "openai-responses"],
  ])("keeps default-route xAI transport for %s with %s", (provider, api) => {
    expect(
      resolveXaiTransport({
        provider,
        api,
      }),
    ).toEqual({
      api: "openai-responses",
      baseUrl: XAI_BASE_URL,
    });
  });

  it.each(["openai-completions", "openai-responses"])(
    "preserves explicit foreign proxy routing for %s",
    (api) => {
      expect(
        resolveXaiTransport({
          provider: "x-ai",
          api,
          baseUrl: "https://proxy.example.test/v1",
        }),
      ).toBeUndefined();
    },
  );

  it.each(["xai", "x-ai"])(
    "restores the native endpoint for materialized %s overlays",
    (provider) => {
      const model = resolveXaiForwardCompatModel({
        providerId: "xai",
        ctx: {
          provider,
          modelId: "grok-4.5",
          modelRegistry: { find: () => null } as never,
          providerConfig: { baseUrl: "", models: [] },
        },
      });

      expect(model?.baseUrl).toBe(XAI_BASE_URL);
      expect(model?.reasoning).toBe(true);
    },
  );

  it("detects xAI model hints", () => {
    expect(isXaiModelHint("x-ai/grok-4")).toBe(true);
  });
});
