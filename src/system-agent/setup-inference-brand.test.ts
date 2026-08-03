import { describe, expect, it } from "vitest";
import { resolveSetupInferenceCandidateBrandId } from "./setup-inference-brand.js";

describe("resolveSetupInferenceCandidateBrandId", () => {
  it("uses canonical brands for built-in coding CLI candidates", () => {
    expect(
      resolveSetupInferenceCandidateBrandId(
        { kind: "claude-cli", modelRef: "claude-cli/claude-opus-4-8" },
        "anthropic",
      ),
    ).toBe("claude");
    expect(
      resolveSetupInferenceCandidateBrandId(
        { kind: "codex-cli", modelRef: "openai/gpt-5.5" },
        "openai",
      ),
    ).toBe("openai");
  });

  it("preserves owner identity for other candidates", () => {
    expect(
      resolveSetupInferenceCandidateBrandId(
        { kind: "provider-auto:local", modelRef: "local/qwen-tool" },
        "local",
      ),
    ).toBe("local");
    expect(
      resolveSetupInferenceCandidateBrandId({
        kind: "anthropic-api-key",
        modelRef: "anthropic/claude-opus-4-8",
      }),
    ).toBe("anthropic");
  });
});
