import { describe, expect, it } from "vitest";
import {
  resolveOpenAIReasoningEffortForModel,
  resolveOpenAISupportedReasoningEfforts,
} from "./openai-reasoning-effort.js";

describe("OpenAI reasoning effort support", () => {
  it.each([
    { provider: "openai", id: "gpt-5.5" },
    { provider: "openai-codex", id: "gpt-5.5" },
  ])("preserves xhigh for $provider/$id", (model) => {
    expect(resolveOpenAISupportedReasoningEfforts(model)).toContain("xhigh");
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "xhigh" })).toBe("xhigh");
  });

  it("does not downgrade xhigh when Pi compat metadata declares it explicitly", () => {
    const model = {
      provider: "openai-codex",
      id: "gpt-5.5",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    };

    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "xhigh" })).toBe("xhigh");
  });
});
