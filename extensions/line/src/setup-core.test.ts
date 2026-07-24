import type { OpenClawConfig } from "openclaw/plugin-sdk/setup";
// Guards the shipped `--token` alias: released CLIs configured LINE through the
// shared token envelope switch, which must keep writing channelAccessToken.
import { describe, expect, it } from "vitest";
import { lineSetupAdapter } from "./setup-core.js";

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
