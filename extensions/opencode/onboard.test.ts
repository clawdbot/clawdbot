// Opencode tests cover onboard plugin behavior.
import { expectProviderOnboardAllowlistAlias } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, it } from "vitest";
import { applyOpencodeZenProviderConfig } from "./onboard.js";

const MODEL_REF = "opencode/claude-opus-5";

describe("opencode onboard", () => {
  it("adds allowlist entry and preserves alias", () => {
    expectProviderOnboardAllowlistAlias({
      applyProviderConfig: applyOpencodeZenProviderConfig,
      modelRef: MODEL_REF,
      alias: "My Opus",
    });
  });
});
