import type { OpenClawConfig } from "openclaw/plugin-sdk/setup";
// Guards the shipped `--token` alias: released CLIs configured LINE through the
// shared token envelope switch, which must keep writing channelAccessToken.
import { describe, expect, it } from "vitest";
import { lineSetupAdapter, patchLineAccountConfig } from "./setup-core.js";

type LineChannelConfig = {
  channelAccessToken?: string;
  channelSecret?: string;
  tokenFile?: string;
  secretFile?: string;
};

function applyLineSetup(
  input: Record<string, unknown>,
  cfg: OpenClawConfig = {} as OpenClawConfig,
): OpenClawConfig {
  return lineSetupAdapter.applyAccountConfig({ cfg, accountId: "default", input });
}

function appliedLineConfig(
  input: Record<string, unknown>,
  cfg?: OpenClawConfig,
): LineChannelConfig {
  return (applyLineSetup(input, cfg).channels?.line ?? {}) as LineChannelConfig;
}

describe("line setup token alias", () => {
  it("maps the shipped --token switch onto channelAccessToken", () => {
    expect(appliedLineConfig({ token: "alias-token" }).channelAccessToken).toBe("alias-token");
  });

  it("prefers the explicit --channel-access-token over the alias", () => {
    const applied = appliedLineConfig({
      token: "alias-token",
      channelAccessToken: "explicit-token",
    });
    expect(applied.channelAccessToken).toBe("explicit-token");
  });
});

describe("LINE scoped setup config", () => {
  it("explicitly re-enables an existing disabled named account", () => {
    const cfg = patchLineAccountConfig({
      cfg: {
        channels: {
          line: {
            enabled: false,
            accounts: {
              work: {
                enabled: false,
                channelAccessToken: "old-token",
              },
            },
          },
        },
      },
      accountId: "work",
      enabled: true,
      patch: { channelAccessToken: "new-token" },
    });

    expect(cfg.channels?.line?.enabled).toBe(true);
    expect(cfg.channels?.line?.accounts?.work).toMatchObject({
      enabled: true,
      channelAccessToken: "new-token",
    });
  });

  it("clears only the selected named-account credential before applying its replacement", () => {
    const cfg = patchLineAccountConfig({
      cfg: {
        channels: {
          line: {
            channelAccessToken: "default-token",
            accounts: {
              work: {
                channelAccessToken: "old-token",
                tokenFile: "/run/secrets/line-work",
              },
            },
          },
        },
      },
      accountId: "work",
      enabled: true,
      clearFields: ["channelAccessToken", "tokenFile"],
      patch: { channelAccessToken: "new-token" },
    });

    expect(cfg.channels?.line?.channelAccessToken).toBe("default-token");
    expect(cfg.channels?.line?.accounts?.work).toEqual({
      enabled: true,
      channelAccessToken: "new-token",
    });
  });
});

describe("LINE credential rotation", () => {
  // The inline value wins over its file at resolution time, so a rotation that
  // leaves it behind silently keeps using the credential it was meant to replace.
  const inlineFirst = () =>
    applyLineSetup({ channelAccessToken: "inline-token", channelSecret: "inline-secret" });

  it("retires an inline credential when its file replaces it", () => {
    const rotated = appliedLineConfig(
      { tokenFile: "/run/secrets/line-token", secretFile: "/run/secrets/line-secret" },
      inlineFirst(),
    );

    expect(rotated.tokenFile).toBe("/run/secrets/line-token");
    expect(rotated.secretFile).toBe("/run/secrets/line-secret");
    expect(rotated.channelAccessToken).toBeUndefined();
    expect(rotated.channelSecret).toBeUndefined();
  });

  it("retires a credential file when an inline value replaces it", () => {
    const fromFiles = applyLineSetup({
      tokenFile: "/run/secrets/line-token",
      secretFile: "/run/secrets/line-secret",
    });

    const rotated = appliedLineConfig(
      { channelAccessToken: "inline-token", channelSecret: "inline-secret" },
      fromFiles,
    );

    expect(rotated.channelAccessToken).toBe("inline-token");
    expect(rotated.channelSecret).toBe("inline-secret");
    expect(rotated.tokenFile).toBeUndefined();
    expect(rotated.secretFile).toBeUndefined();
  });

  it("leaves the credential that was not replaced alone", () => {
    const rotated = appliedLineConfig({ tokenFile: "/run/secrets/line-token" }, inlineFirst());

    expect(rotated.tokenFile).toBe("/run/secrets/line-token");
    expect(rotated.channelSecret).toBe("inline-secret");
    expect(rotated.channelAccessToken).toBeUndefined();
  });
});
