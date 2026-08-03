// Error-context helper tests keep failure metadata pointed at the model that
// actually failed, even when the embedded harness wraps the provider call.
import { describe, expect, it } from "vitest";
import { resolveActiveErrorContext } from "./helpers.js";

describe("resolveActiveErrorContext", () => {
  it("returns the current provider/model", () => {
    const result = resolveActiveErrorContext({
      provider: "deepseek",
      model: "deepseek-chat",
    });
    expect(result).toEqual({ provider: "deepseek", model: "deepseek-chat" });
  });

  it("prefers assistant provider/model when the failing attempt reports them", () => {
    const result = resolveActiveErrorContext({
      provider: "openai",
      model: "gpt-5.4",
      assistant: {
        provider: "openai",
        model: "gpt-5.4-codex",
      },
    });

    expect(result).toEqual({ provider: "openai", model: "gpt-5.4-codex" });
  });

  it("ignores the embedded OpenClaw harness provider when the model provider is known", () => {
    // The OpenClaw harness id is a transport wrapper, not the provider users
    // need in diagnostics when a concrete upstream model ref is available.
    const result = resolveActiveErrorContext({
      provider: "openrouter",
      model: "openai/gpt-5.4",
      assistant: {
        provider: "openclaw",
        model: "openclaw",
      },
    });

    expect(result).toEqual({ provider: "openrouter", model: "openai/gpt-5.4" });
  });
});
