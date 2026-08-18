import { describe, expect, it } from "vitest";
import { normalizeLlamaServerThinking } from "./stream.js";

describe("llama-server stream payload", () => {
  it("maps thinking off to llama-server chat-template kwargs", () => {
    expect(
      normalizeLlamaServerThinking(
        {
          model: "model",
          chat_template_kwargs: { preserve_thinking: true, enable_thinking: true },
        },
        "off",
      ),
    ).toEqual({
      model: "model",
      chat_template_kwargs: { preserve_thinking: true, enable_thinking: false },
    });
  });

  it("does not force thinking on when OpenClaw selected another level", () => {
    const payload = { model: "model" };
    expect(normalizeLlamaServerThinking(payload, "high")).toBe(payload);
  });
});
