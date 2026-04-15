import { describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import type { CoreAgentDeps } from "./core-bridge.js";
import { resolveVoiceResponseModel } from "./response-model.js";

const agentRuntime = {
  defaults: {
    provider: "together",
    model: "Qwen/Qwen2.5-7B-Instruct-Turbo",
  },
} as unknown as CoreAgentDeps;

describe("resolveVoiceResponseModel", () => {
  it("falls back to the runtime default model", () => {
    expect(
      resolveVoiceResponseModel({
        voiceConfig: VoiceCallConfigSchema.parse({}),
        agentRuntime,
      }),
    ).toEqual({
      modelRef: "together/Qwen/Qwen2.5-7B-Instruct-Turbo",
      provider: "together",
      model: "Qwen/Qwen2.5-7B-Instruct-Turbo",
    });
  });

  it("uses an explicit provider/model ref", () => {
    expect(
      resolveVoiceResponseModel({
        voiceConfig: VoiceCallConfigSchema.parse({
          responseModel: "openai/gpt-5.4-mini",
        }),
        agentRuntime,
      }),
    ).toEqual({
      modelRef: "openai/gpt-5.4-mini",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
  });

  it("uses the runtime default provider for bare model overrides", () => {
    expect(
      resolveVoiceResponseModel({
        voiceConfig: VoiceCallConfigSchema.parse({
          responseModel: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
        }),
        agentRuntime,
      }),
    ).toEqual({
      modelRef: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
      provider: "meta-llama",
      model: "Llama-4-Scout-17B-16E-Instruct",
    });
  });

  it("keeps legacy single-segment overrides on the runtime default provider", () => {
    expect(
      resolveVoiceResponseModel({
        voiceConfig: VoiceCallConfigSchema.parse({
          responseModel: "gpt-5.4-mini",
        }),
        agentRuntime,
      }),
    ).toEqual({
      modelRef: "gpt-5.4-mini",
      provider: "together",
      model: "gpt-5.4-mini",
    });
  });
});
