import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { formatAgentModelStartupLog } from "./server-startup-log.js";

describe("gateway startup model log", () => {
  it("formats configured thinking and fast mode defaults", () => {
    const modelLog = formatAgentModelStartupLog(
      {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            models: {
              "openai/gpt-5.5": {
                params: {
                  fastMode: true,
                  thinking: "medium",
                },
              },
            },
            reasoningDefault: "stream",
          },
        },
      },
      { manifestPlugins: [] },
    );

    expect(modelLog.message).toBe("agent model: openai/gpt-5.5 (thinking=medium, fast=on)");
    expect(stripAnsi(modelLog.consoleMessage)).toBe(
      "agent model: openai/gpt-5.5 (thinking=medium, fast=on)",
    );
  });
});
