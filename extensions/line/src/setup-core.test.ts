import type { OpenClawConfig } from "openclaw/plugin-sdk/setup";
// Guards the shipped `--token` alias: released CLIs configured LINE through the
// shared token envelope switch, which must keep writing channelAccessToken.
import { describe, expect, it } from "vitest";
import { lineSetupAdapter, patchLineAccountConfig } from "./setup-core.js";

type LineChannelConfig = { channelAccessToken?: string };

function appliedLineConfig(input: Record<string, unknown>): LineChannelConfig {
  const cfg = lineSetupAdapter.applyAccountConfig({
    cfg: {} as OpenClawConfig,
    accountId: "default",
    input,
  });
  return (cfg.channels?.line ?? {}) as LineChannelConfig;
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
