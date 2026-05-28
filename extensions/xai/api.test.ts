import { describe, expect, it } from "vitest";
import { isXaiModelHint, resolveXaiTransport } from "./api.js";

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

  it("keeps default-route xAI transport for the declared provider", () => {
    expect(
      resolveXaiTransport({
        provider: "xai",
        api: "openai-completions",
      }),
    ).toEqual({
      api: "openai-responses",
      baseUrl: undefined,
    });
  });

  it("detects xAI model hints", () => {
    expect(isXaiModelHint("x-ai/grok-4")).toBe(true);
  });
});
