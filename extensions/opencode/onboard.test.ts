import { describe, it } from "vitest";
import {
  expectProviderOnboardAllowlistAlias,
  expectProviderOnboardPrimaryAndFallbacks,
} from "../../test/helpers/plugins/provider-onboard.js";
import { applyOpencodeZenConfig, applyOpencodeZenProviderConfig } from "./onboard.js";

const MODEL_REF = "opencode/claude-opus-4-6";

describe("opencode onboard", () => {
  it("adds allowlist entry and preserves alias", () => {
    expectProviderOnboardAllowlistAlias({
      applyProviderConfig: applyOpencodeZenProviderConfig,
      modelRef: MODEL_REF,
      alias: "My Opus",
    });
  });

  it("sets primary model and preserves existing model fallbacks", () => {
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyOpencodeZenConfig,
      modelRef: MODEL_REF,
    });
  });
});
