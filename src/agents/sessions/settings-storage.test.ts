import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SettingsManager } from "./settings-manager.js";
import { FileSettingsStorage } from "./settings-storage.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("FileSettingsStorage", () => {
  it("loads missing settings without creating their directories", () => {
    const root = tempDirs.make("openclaw-settings-read-");
    const settingsDir = join(root, "agent");

    SettingsManager.create(root, settingsDir);

    expect(existsSync(settingsDir)).toBe(false);
    expect(existsSync(join(root, ".openclaw"))).toBe(false);
  });

  it("locks before reading when the settings directory exists", () => {
    const root = tempDirs.make("openclaw-settings-lock-");
    const settingsDir = join(root, "agent");
    const settingsPath = join(settingsDir, "settings.json");
    mkdirSync(settingsDir);
    const storage = new FileSettingsStorage(settingsDir, settingsDir);
    let lockedDuringRead = false;

    storage.withLock("global", (current) => {
      lockedDuringRead = existsSync(`${settingsPath}.lock`);
      expect(current).toBeUndefined();
      return undefined;
    });

    expect(lockedDuringRead).toBe(true);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("creates a missing directory when the callback writes", () => {
    const root = tempDirs.make("openclaw-settings-write-");
    const settingsDir = join(root, "agent");
    const settingsPath = join(settingsDir, "settings.json");
    const storage = new FileSettingsStorage(settingsDir, settingsDir);

    storage.withLock("global", () => JSON.stringify({ theme: "dark" }));

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "dark" });
  });
});
