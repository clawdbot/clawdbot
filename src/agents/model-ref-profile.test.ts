import { describe, expect, it } from "vitest";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";

describe("splitTrailingAuthProfile", () => {
  it("returns trimmed model when no profile suffix exists", () => {
    expect(splitTrailingAuthProfile(" openai/gpt-5 ")).toEqual({
      model: "openai/gpt-5",
    });
  });

  it("splits trailing @profile suffix", () => {
    expect(splitTrailingAuthProfile("openai/gpt-5@work")).toEqual({
      model: "openai/gpt-5",
      profile: "work",
    });
  });

  it("keeps @-prefixed path segments in model ids", () => {
    expect(splitTrailingAuthProfile("openai/@cf/openai/gpt-oss-20b")).toEqual({
      model: "openai/@cf/openai/gpt-oss-20b",
    });
  });

  it("supports trailing profile override after @-prefixed path segments", () => {
    expect(splitTrailingAuthProfile("openai/@cf/openai/gpt-oss-20b@cf:default")).toEqual({
      model: "openai/@cf/openai/gpt-oss-20b",
      profile: "cf:default",
    });
  });

  it("keeps openrouter preset paths without profile override", () => {
    expect(splitTrailingAuthProfile("openrouter/@preset/kimi-2-5")).toEqual({
      model: "openrouter/@preset/kimi-2-5",
    });
  });

  it("supports openrouter preset profile overrides", () => {
    expect(splitTrailingAuthProfile("openrouter/@preset/kimi-2-5@work")).toEqual({
      model: "openrouter/@preset/kimi-2-5",
      profile: "work",
    });
  });

  it("does not split when suffix after @ contains slash", () => {
    expect(splitTrailingAuthProfile("provider/foo@bar/baz")).toEqual({
      model: "provider/foo@bar/baz",
    });
  });

  it("uses first @ after last slash for email-based auth profiles", () => {
    expect(splitTrailingAuthProfile("flash@google-gemini-cli:test@gmail.com")).toEqual({
      model: "flash",
      profile: "google-gemini-cli:test@gmail.com",
    });
  });

  it("keeps @YYYYMMDD version suffixes in model ids", () => {
    expect(splitTrailingAuthProfile("custom/vertex-ai_claude-haiku-4-5@20251001")).toEqual({
      model: "custom/vertex-ai_claude-haiku-4-5@20251001",
    });
  });

  it("supports auth profiles after @YYYYMMDD version suffixes", () => {
    expect(splitTrailingAuthProfile("custom/vertex-ai_claude-haiku-4-5@20251001@work")).toEqual({
      model: "custom/vertex-ai_claude-haiku-4-5@20251001",
      profile: "work",
    });
  });

  it("keeps @q* quant suffixes in model ids", () => {
    expect(splitTrailingAuthProfile("lmstudio-mb-pro/gemma-4-31b-it@q8_0")).toEqual({
      model: "lmstudio-mb-pro/gemma-4-31b-it@q8_0",
    });
  });

  it("supports auth profiles after @q* quant suffixes", () => {
    expect(splitTrailingAuthProfile("lmstudio-mb-pro/gemma-4-31b-it@q8_0@work")).toEqual({
      model: "lmstudio-mb-pro/gemma-4-31b-it@q8_0",
      profile: "work",
    });
  });

  it("keeps @iq* importance-quantization suffixes in model ids", () => {
    expect(splitTrailingAuthProfile("lmstudio/qwen3.6-27b@iq3_xxs")).toEqual({
      model: "lmstudio/qwen3.6-27b@iq3_xxs",
    });
    expect(splitTrailingAuthProfile("lmstudio/qwen3.6-27b@iq4_xs")).toEqual({
      model: "lmstudio/qwen3.6-27b@iq4_xs",
    });
  });

  it("supports auth profiles after @iq* quant suffixes", () => {
    expect(splitTrailingAuthProfile("lmstudio/qwen3.6-27b@iq3_xxs@work")).toEqual({
      model: "lmstudio/qwen3.6-27b@iq3_xxs",
      profile: "work",
    });
  });

  it("keeps @4bit/@8bit quant suffixes in model ids", () => {
    expect(splitTrailingAuthProfile("lmstudio-mb-pro/gemma-4-31b@4bit")).toEqual({
      model: "lmstudio-mb-pro/gemma-4-31b@4bit",
    });
    expect(splitTrailingAuthProfile("lmstudio-mb-pro/gemma-4-31b@8bit")).toEqual({
      model: "lmstudio-mb-pro/gemma-4-31b@8bit",
    });
  });
});
