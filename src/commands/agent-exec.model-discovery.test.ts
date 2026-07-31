import { describe, expect, it } from "vitest";
import { buildExecRunConfig } from "./agent-exec.js";

describe("agent exec model discovery", () => {
  it("admits explicit model routes before refreshable provider discovery", () => {
    const config = buildExecRunConfig({
      base: {
        agents: {
          defaults: {
            models: {
              "huggingface/Qwen/Qwen3.5-9B:together": {
                params: { temperature: 0 },
              },
            },
          },
        },
      },
      cwd: "/run/here",
      opts: {
        model: "huggingface/Qwen/Qwen3.5-9B:together",
        fallback: ["anthropic/claude-sonnet-5"],
      },
    });

    expect(config.agents?.defaults?.models).toEqual({
      "huggingface/Qwen/Qwen3.5-9B:together": {
        params: { temperature: 0 },
      },
      "anthropic/claude-sonnet-5": {},
    });
  });
});
