import type { Model } from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { applyExtraParamsToAgent } from "./pi-embedded-runner.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["OPENAI_LIVE_TEST"]);
const ANTHROPIC_LIVE = isLiveTestEnabled(["ANTHROPIC_LIVE_TEST"]);

const describeLive = LIVE && OPENAI_KEY ? describe : describe.skip;
const describeAnthropicLive = ANTHROPIC_LIVE && ANTHROPIC_KEY ? describe : describe.skip;

describeLive("pi embedded extra params (live)", () => {
  it("applies config maxTokens to openai streamFn", async () => {
    const model = getModel("openai", "gpt-5.4") as unknown as Model<"openai-completions">;

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {
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

    expect(stopReason).toBeTypeOf("string");
    expect(outputTokens).toBeTypeOf("number");
    // Should respect maxTokens from config (16) — allow a small buffer for provider rounding.
    expect(outputTokens ?? 0).toBeLessThanOrEqual(20);
  }, 30_000);

  it("verifies OpenAI fast-mode service_tier semantics against the live API", async () => {
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_KEY}`,
    };

    const runProbe = async (serviceTier: "default" | "priority") => {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "gpt-5.4",
          input: "Reply with OK.",
          max_output_tokens: 32,
          service_tier: serviceTier,
        }),
      });
      const json = (await res.json()) as {
        error?: { message?: string };
        service_tier?: string;
        status?: string;
      };
      expect(res.ok, json.error?.message ?? `HTTP ${res.status}`).toBe(true);
      return json;
    };

    const standard = await runProbe("default");
    expect(standard.service_tier).toBe("default");
    expect(standard.status).toBe("completed");

    const fast = await runProbe("priority");
    expect(fast.service_tier).toBe("priority");
    expect(fast.status).toBe("completed");
  }, 45_000);
});

describeAnthropicLive("pi embedded extra params (anthropic live)", () => {
  it("verifies Anthropic fast-mode service_tier semantics against the live API", async () => {
    const headers = {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    };

    const runProbe = async (serviceTier: "auto" | "standard_only") => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 32,
          service_tier: serviceTier,
          messages: [{ role: "user", content: "Reply with OK." }],
        }),
      });
      const json = (await res.json()) as {
        error?: { message?: string };
        stop_reason?: string;
        usage?: { service_tier?: string };
      };
      expect(res.ok, json.error?.message ?? `HTTP ${res.status}`).toBe(true);
      return json;
    };

    const standard = await runProbe("standard_only");
    expect(standard.usage?.service_tier).toBe("standard");
    expect(standard.stop_reason).toBe("end_turn");

    const fast = await runProbe("auto");
    expect(["standard", "priority"]).toContain(fast.usage?.service_tier);
    expect(fast.stop_reason).toBe("end_turn");
  }, 45_000);
});
