/** Tests session settings manager runtime overrides. */
import { describe, expect, it } from "vitest";
import { SettingsManager } from "./settings-manager.js";

describe("SettingsManager runtime overrides", () => {
  it("preserves compaction overrides after global setting writes", async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    });

    settingsManager.applyOverrides({
      compaction: { reserveTokens: 50_000, keepRecentTokens: 16_000 },
    });
    settingsManager.setCompactionEnabled(false);

    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 50_000,
      keepRecentTokens: 16_000,
    });

    await settingsManager.flush();
    await settingsManager.reload();

    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 50_000,
      keepRecentTokens: 16_000,
    });
  });

  it("preserves runtime overrides after project setting writes", async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { reserveTokens: 16_384 },
    });

    settingsManager.applyOverrides({ compaction: { reserveTokens: 50_000 } });
    settingsManager.setProjectPackages(["npm:@openclaw/example"]);

    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/example"]);
    expect(settingsManager.getCompactionReserveTokens()).toBe(50_000);

    await settingsManager.flush();
    await settingsManager.reload();

    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/example"]);
    expect(settingsManager.getCompactionReserveTokens()).toBe(50_000);
  });

  it("recursively merges provider retry overrides and replaces arrays", () => {
    const settingsManager = SettingsManager.inMemory({
      retry: {
        provider: { timeoutMs: 30_000, maxRetries: 2, maxRetryDelayMs: 60_000 },
      },
      packages: ["npm:@openclaw/base"],
    });

    settingsManager.applyOverrides({
      retry: { provider: { maxRetries: 5 } },
      packages: ["npm:@openclaw/override"],
    });

    expect(settingsManager.getProviderRetrySettings()).toEqual({
      timeoutMs: 30_000,
      maxRetries: 5,
      maxRetryDelayMs: 60_000,
    });
    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/override"]);
  });
});
