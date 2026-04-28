import { expectProviderOnboardPrimaryAndFallbacks } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { applyOpencodeGoConfig, applyOpencodeGoProviderConfig } from "./onboard.js";

const MODEL_REF = "opencode-go/kimi-k2.6";

describe("opencode-go onboard", () => {
  it("leaves model aliases to the pi catalog", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            [MODEL_REF]: { alias: "Kimi" },
          },
        },
      },
    };

    expect(applyOpencodeGoProviderConfig(cfg)).toBe(cfg);
  });

  it("sets primary model and preserves existing model fallbacks", () => {
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyOpencodeGoConfig,
      modelRef: MODEL_REF,
    });
  });
});
