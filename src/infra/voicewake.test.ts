import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultVoiceWakeTriggers,
  loadVoiceWakeConfig,
  setVoiceWakeTriggers,
} from "./voicewake.js";

describe("voicewake store", () => {
  it("returns defaults when missing", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-voicewake-"));
    const cfg = await loadVoiceWakeConfig(baseDir);
    expect(cfg.triggers).toEqual(defaultVoiceWakeTriggers());
    expect(cfg.updatedAtMs).toBe(0);
  });

  it("sanitizes and persists triggers", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-voicewake-"));
    const saved = await setVoiceWakeTriggers(["  hi  ", "", "  there "], baseDir);
    expect(saved.triggers).toEqual(["hi", "there"]);
    expect(saved.updatedAtMs).toBeGreaterThan(0);

    const loaded = await loadVoiceWakeConfig(baseDir);
    expect(loaded.triggers).toEqual(["hi", "there"]);
    expect(loaded.updatedAtMs).toBeGreaterThan(0);
  });

  it("falls back to defaults when triggers empty", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-voicewake-"));
    const saved = await setVoiceWakeTriggers(["", "   "], baseDir);
    expect(saved.triggers).toEqual(defaultVoiceWakeTriggers());
  });
});
