/**
 * Tests Telegram account helper behavior.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const apiModule = {
    resolveTelegramAccount: vi.fn(() => ({
      accountId: "default",
      config: {},
      enabled: true,
      token: "token",
      tokenSource: "config",
    })),
  };

  return {
    apiModule,
    loadBundledPluginPublicSurfaceModuleSyncCore: vi.fn(() => apiModule),
  };
});

vi.mock("./facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSyncCore: mocks.loadBundledPluginPublicSurfaceModuleSyncCore,
}));

describe("telegram account plugin-sdk compatibility facade", () => {
  it("forwards account resolution through Telegram's public surface", async () => {
    const { resolveTelegramAccount } = await import("./telegram-account.js");
    const cfg = { channels: { telegram: { botToken: "token" } } };

    const account = resolveTelegramAccount({ cfg, accountId: "default" });

    expect(mocks.loadBundledPluginPublicSurfaceModuleSyncCore).toHaveBeenCalledWith({
      dirName: "telegram",
      artifactBasename: "api.js",
    });
    expect(mocks.apiModule.resolveTelegramAccount).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
    });
    expect(account.accountId).toBe("default");
    expect(account.token).toBe("token");
  });
});
