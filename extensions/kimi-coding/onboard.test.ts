import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
  applyKimiCodeConfig,
  applyKimiCodeProviderConfig,
  KIMI_CODING_MODEL_REF,
  KIMI_MODEL_REF,
} from "./onboard.js";

describe("kimi coding onboard", () => {
  it("keeps the historical Kimi model ref alias pointed at the coding default", () => {
    expect(KIMI_MODEL_REF).toBe("kimi/kimi-code");
    expect(KIMI_CODING_MODEL_REF).toBe(KIMI_MODEL_REF);
  });

  it("adds the Kimi coding provider defaults", () => {
    const cfg = applyKimiCodeProviderConfig({});
    const provider = cfg.models?.providers?.kimi;

    expect(provider).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://api.kimi.com/coding/",
    });
    expect(provider?.models?.map((model) => model.id)).toEqual(["kimi-code"]);
    expect(cfg.agents?.defaults?.models?.[KIMI_MODEL_REF]?.alias).toBe("Kimi");
  });

  it("sets the agent primary model when applying the full Kimi coding preset", () => {
    const cfg = applyKimiCodeConfig({});

    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(KIMI_MODEL_REF);
  });
});
