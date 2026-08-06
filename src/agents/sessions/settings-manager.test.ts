/** Tests session settings loading, persistence, and runtime overrides. */
import { describe, expect, it } from "vitest";
import { SettingsManager, type SettingsScope, type SettingsStorage } from "./settings-manager.js";

class InspectableSettingsStorage implements SettingsStorage {
  private values: Record<SettingsScope, string | undefined> = {
    global: undefined,
    project: undefined,
  };

  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
    const next = fn(this.values[scope]);
    if (next !== undefined) {
      this.values[scope] = next;
    }
  }

  set(scope: SettingsScope, value: unknown): void {
    this.values[scope] = typeof value === "string" ? value : JSON.stringify(value);
  }

  get(scope: SettingsScope): unknown {
    const value = this.values[scope];
    return value === undefined ? undefined : JSON.parse(value);
  }
}

describe("SettingsManager scoped persistence", () => {
  it("preserves external sibling changes while writing global and project scopes", async () => {
    const storage = new InspectableSettingsStorage();
    storage.set("global", {
      terminal: { showImages: true, imageWidthCells: 60 },
      packages: ["npm:@openclaw/global"],
    });
    storage.set("project", {
      packages: ["npm:@openclaw/project"],
      skills: ["old-skill"],
    });
    const settingsManager = SettingsManager.fromStorage(storage);

    const updatedSkills = ["new-skill"];
    settingsManager.setShowImages(false);
    settingsManager.setProjectSkillPaths(updatedSkills);
    updatedSkills.push("caller-mutation");
    storage.set("global", {
      terminal: { showImages: true, imageWidthCells: 120, clearOnShrink: true },
      packages: ["npm:@openclaw/global"],
    });
    storage.set("project", {
      packages: ["npm:@openclaw/external"],
      skills: ["old-skill"],
      themes: ["external-theme"],
    });

    await settingsManager.flush();

    expect(storage.get("global")).toEqual({
      terminal: { showImages: false, imageWidthCells: 120, clearOnShrink: true },
      packages: ["npm:@openclaw/global"],
    });
    expect(storage.get("project")).toEqual({
      packages: ["npm:@openclaw/external"],
      skills: ["new-skill"],
      themes: ["external-theme"],
    });

    await settingsManager.reload();
    expect(settingsManager.getShowImages()).toBe(false);
    expect(settingsManager.getImageWidthCells()).toBe(120);
    expect(settingsManager.getClearOnShrink()).toBe(true);
    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/external"]);
    expect(settingsManager.getSkillPaths()).toEqual(["new-skill"]);
    expect(settingsManager.getThemePaths()).toEqual(["external-theme"]);
  });

  it("isolates parse failures to the affected scope", async () => {
    const storage = new InspectableSettingsStorage();
    storage.set("global", "{");
    storage.set("project", { skills: ["old-skill"] });
    const settingsManager = SettingsManager.fromStorage(storage);

    expect(settingsManager.drainErrors()).toEqual([
      expect.objectContaining({ scope: "global", error: expect.any(SyntaxError) }),
    ]);
    settingsManager.setTheme("blocked-global-write");
    settingsManager.setProjectSkillPaths(["new-skill"]);
    await settingsManager.flush();

    expect(() => storage.get("global")).toThrow(SyntaxError);
    expect(storage.get("project")).toEqual({ skills: ["new-skill"] });
  });
});

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
