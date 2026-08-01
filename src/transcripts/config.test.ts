import { describe, expect, it } from "vitest";
import { resolveTranscriptsConfig } from "./config.js";

describe("resolveTranscriptsConfig", () => {
  it("enables meeting transcripts by default with an explicit global opt-out", () => {
    expect(resolveTranscriptsConfig(undefined).enabled).toBe(true);
    expect(resolveTranscriptsConfig({}).enabled).toBe(true);
    expect(resolveTranscriptsConfig({ enabled: false }).enabled).toBe(false);
  });
});
