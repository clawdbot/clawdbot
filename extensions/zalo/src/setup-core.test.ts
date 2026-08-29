import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { zaloSetupAdapter } from "./setup-core.js";

type ZaloChannelConfig = {
  botToken?: string;
  tokenFile?: string;
};

function applyZaloSetup(
  input: Record<string, unknown>,
  cfg: OpenClawConfig = {} as OpenClawConfig,
): OpenClawConfig {
  return zaloSetupAdapter.applyAccountConfig({ cfg, accountId: "default", input });
}

function appliedZaloConfig(
  input: Record<string, unknown>,
  cfg?: OpenClawConfig,
): ZaloChannelConfig {
  return (applyZaloSetup(input, cfg).channels?.zalo ?? {}) as ZaloChannelConfig;
}

describe("zalo credential rotation", () => {
  // Inline botToken wins over tokenFile at resolution time, so a rotation that
  // leaves it behind silently keeps using the credential it was meant to replace.
  it("retires an inline token when a token file replaces it", () => {
    const fromInline = applyZaloSetup({ token: "inline-token" });

    const rotated = appliedZaloConfig({ tokenFile: "/run/secrets/zalo-token" }, fromInline);

    expect(rotated.tokenFile).toBe("/run/secrets/zalo-token");
    expect(rotated.botToken).toBeUndefined();
  });

  it("retires a token file when an inline token replaces it", () => {
    const fromFile = applyZaloSetup({ tokenFile: "/run/secrets/zalo-token" });

    const rotated = appliedZaloConfig({ token: "inline-token" }, fromFile);

    expect(rotated.botToken).toBe("inline-token");
    expect(rotated.tokenFile).toBeUndefined();
  });

  it("retires both sources when switching to the environment", () => {
    const fromFile = applyZaloSetup({ tokenFile: "/run/secrets/zalo-token" });

    const rotated = appliedZaloConfig({ useEnv: true }, fromFile);

    expect(rotated.botToken).toBeUndefined();
    expect(rotated.tokenFile).toBeUndefined();
  });
});
