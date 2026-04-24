import fs from "node:fs";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { createCapturedThinkingConfigStream } from "../../test/helpers/plugins/stream-hooks.js";
import plugin from "./index.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

type MoonshotManifest = {
  providerAuthEnvVars?: Record<string, string[]>;
};

function readManifest(): MoonshotManifest {
  return JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as MoonshotManifest;
}

describe("moonshot provider plugin", () => {
  it("mirrors Kimi web-search env credentials in manifest metadata", () => {
    const manifestEnvVars = readManifest().providerAuthEnvVars?.moonshot ?? [];

    expect(manifestEnvVars).toEqual(expect.arrayContaining(createKimiWebSearchProvider().envVars));
  });

  it("owns replay policy for OpenAI-compatible Moonshot transports without mangling native Kimi tool_call IDs", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const policy = provider.buildReplayPolicy?.({
      provider: "moonshot",
      modelApi: "openai-completions",
      modelId: "kimi-k2.6",
    } as never);

    expect(policy).toMatchObject({
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
    expect(policy).not.toHaveProperty("sanitizeToolCallIds");
    expect(policy).not.toHaveProperty("toolCallIdMode");
  });

  it("wires moonshot-thinking stream hooks", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedStream = createCapturedThinkingConfigStream();

    const wrapped = provider.wrapStreamFn?.({
      provider: "moonshot",
      modelId: "kimi-k2.6",
      thinkingLevel: "off",
      streamFn: capturedStream.streamFn,
    } as never);

    void wrapped?.(
      {
        api: "openai-completions",
        provider: "moonshot",
        id: "kimi-k2.6",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedStream.getCapturedPayload()).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      thinking: { type: "disabled" },
    });
  });
});
