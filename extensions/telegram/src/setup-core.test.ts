import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { telegramSetupAdapter } from "./setup-core.js";
import { resolveTelegramToken } from "./token.js";

type TelegramChannelConfig = {
  botToken?: string;
  tokenFile?: string;
  accounts?: Record<string, { botToken?: string; tokenFile?: string; name?: string }>;
};

function applyTelegramSetup(
  input: Record<string, unknown>,
  cfg: OpenClawConfig = {} as OpenClawConfig,
): OpenClawConfig {
  return telegramSetupAdapter.applyAccountConfig({ cfg, accountId: "default", input });
}

function appliedTelegramConfig(
  input: Record<string, unknown>,
  cfg?: OpenClawConfig,
): TelegramChannelConfig {
  return (applyTelegramSetup(input, cfg).channels?.telegram ?? {}) as TelegramChannelConfig;
}

describe("telegram credential rotation", () => {
  // tokenFile wins over inline botToken at resolution time, so a rotation that
  // leaves it behind silently keeps using the credential it was meant to replace.
  it("retires a token file when an inline token replaces it", () => {
    const fromFile = applyTelegramSetup({ tokenFile: "/run/secrets/telegram-token" });

    const rotated = appliedTelegramConfig({ token: "inline-token" }, fromFile);

    expect(rotated.botToken).toBe("inline-token");
    expect(rotated.tokenFile).toBeUndefined();
  });

  it("retires an inline token when a token file replaces it", () => {
    const fromInline = applyTelegramSetup({ token: "inline-token" });

    const rotated = appliedTelegramConfig({ tokenFile: "/run/secrets/telegram-token" }, fromInline);

    expect(rotated.tokenFile).toBe("/run/secrets/telegram-token");
    expect(rotated.botToken).toBeUndefined();
  });

  it("retires both sources when switching to the environment", () => {
    const fromInline = applyTelegramSetup({ token: "inline-token" });

    const rotated = appliedTelegramConfig({ useEnv: true }, fromInline);

    expect(rotated.botToken).toBeUndefined();
    expect(rotated.tokenFile).toBeUndefined();
  });

  it("retires a promoted accounts.default token so the rotation wins at resolution", () => {
    // Named-account setup promotes the root credential into accounts.default,
    // and resolution reads that record ahead of the root fields.
    const promoted = {
      channels: {
        telegram: {
          enabled: true,
          accounts: {
            default: { botToken: "promoted-stale-token", name: "Main" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const rotatedConfig = applyTelegramSetup({ token: "rotated-token" }, promoted);
    const rotated = (rotatedConfig.channels?.telegram ?? {}) as TelegramChannelConfig;

    expect(rotated.botToken).toBe("rotated-token");
    expect(rotated.accounts?.default?.botToken).toBeUndefined();
    expect(rotated.accounts?.default?.name).toBe("Main");
    expect(resolveTelegramToken(rotatedConfig).token).toBe("rotated-token");
  });
});
