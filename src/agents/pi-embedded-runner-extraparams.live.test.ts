import type { Model } from "@mariozechner/pi-ai";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";
import type { MoltbotConfig } from "../config/config.js";
import { applyExtraParamsToAgent } from "./pi-embedded-runner.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const LIVE = isTruthyEnvValue(process.env.OPENAI_LIVE_TEST) || isTruthyEnvValue(process.env.LIVE);

const describeLive = LIVE && OPENAI_KEY ? describe : describe.skip;

describeLive("pi embedded extra params (live)", () => {
  it("applies config maxTokens to openai streamFn", async () => {
    const model = getModel("openai", "gpt-5.2") as Model<"openai-completions">;

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.2": {
              // OpenAI Responses enforces a minimum max_output_tokens of 16.
              params: {
                maxTokens: 16,
              },
            },
          },
        },
      },
    };

    const agent = { streamFn: streamSimple };

    applyExtraParamsToAgent(agent, cfg, "openai", model.id);

    const stream = agent.streamFn(
      model,
      {
        messages: [
          {
            role: "user",
            content: "Write the alphabet letters A through Z as words separated by commas.",
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: OPENAI_KEY },
    );

    let stopReason: string | undefined;
    let outputTokens: number | undefined;
    for await (const event of stream) {
      if (event.type === "done") {
        stopReason = event.reason;
        outputTokens = event.message.usage.output;
      }
    }

    expect(stopReason).toBeDefined();
    expect(outputTokens).toBeDefined();
    // Should respect maxTokens from config (16) — allow a small buffer for provider rounding.
    expect(outputTokens ?? 0).toBeLessThanOrEqual(20);
  }, 30_000);
});
