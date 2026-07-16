import { describe, expect, it } from "vitest";
import {
  assertCodeModeResponsesToolSurface,
  enforceCodeModeResponsesToolSurface,
} from "./openai-transport-params.js";

describe("OpenAI Code Mode direct tools", () => {
  it("keeps the native image loader model-visible", () => {
    const payload = {
      tools: ["exec", "wait", "computer", "image", "web_fetch"].map((name) => ({
        type: "function",
        name,
      })),
    };

    enforceCodeModeResponsesToolSurface(payload);

    expect(payload.tools.map((tool) => tool.name)).toEqual(["exec", "wait", "computer", "image"]);
    expect(() => assertCodeModeResponsesToolSurface(payload)).not.toThrow();
  });
});
