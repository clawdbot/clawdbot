import { describe, expect, it } from "vitest";
import { formatModelOverrideResetEvent } from "./get-reply-directives-apply.js";

describe("formatModelOverrideResetEvent", () => {
  it("names the rejected model override and allowlist recovery path", () => {
    expect(
      formatModelOverrideResetEvent({
        rejectedRef: "ollama/Gemma4-26b-a4-it-gguf",
        initialModelLabel: "github-copilot/gpt-4o",
      }),
    ).toBe(
      "Model override ollama/Gemma4-26b-a4-it-gguf is not allowed for this agent; reverted to github-copilot/gpt-4o. Add ollama/Gemma4-26b-a4-it-gguf to agents.defaults.models or pick an allowed model with /model list.",
    );
  });

  it("keeps the legacy generic message when the rejected ref is unknown", () => {
    expect(
      formatModelOverrideResetEvent({
        initialModelLabel: "github-copilot/gpt-4o",
      }),
    ).toBe("Model override not allowed for this agent; reverted to github-copilot/gpt-4o.");
  });
});
