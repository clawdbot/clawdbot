import {
  assertCodeModeResponsesToolSurface,
  enforceCodeModeResponsesToolSurface,
} from "@openclaw/ai/transports";
import { describe, expect, it } from "vitest";

describe("OpenAI Code Mode direct tools", () => {
  it("keeps policy-required direct tools model-visible", () => {
    const payload = {
      tools: ["exec", "wait", "computer", "image", "message", "web_fetch"].map((name) => ({
        type: "function",
        name,
      })),
    };

    enforceCodeModeResponsesToolSurface(payload);

    expect(payload.tools.map((tool) => tool.name)).toEqual([
      "exec",
      "wait",
      "computer",
      "image",
      "message",
    ]);
    expect(() => assertCodeModeResponsesToolSurface(payload)).not.toThrow();
  });
});
