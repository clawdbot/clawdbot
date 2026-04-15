import { describe, it } from "vitest";
import {
  expectProviderOnboardAllowlistAlias,
  expectProviderOnboardPrimaryAndFallbacks,
} from "../../test/helpers/plugins/provider-onboard.js";
import { applyOpencodeGoConfig, applyOpencodeGoProviderConfig } from "./onboard.js";

const MODEL_REF = "opencode-go/kimi-k2.5";

describe("opencode-go onboard", () => {
  it("adds allowlist entry and preserves alias", () => {
    expectProviderOnboardAllowlistAlias({
      applyProviderConfig: applyOpencodeGoProviderConfig,
      modelRef: MODEL_REF,
      alias: "Kimi",
    });
  });

  it("sets primary model and preserves existing model fallbacks", () => {
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyOpencodeGoConfig,
      modelRef: MODEL_REF,
    });
  });
});
