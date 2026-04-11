import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { shouldAttemptTtsPayload } from "./tts-config.js";

describe("shouldAttemptTtsPayload", () => {
  let originalPrefsPath: string | undefined;
  let dir: string;
  let prefsPath: string;

  beforeEach(() => {
    originalPrefsPath = process.env.OPENCLAW_TTS_PREFS;
    dir = mkdtempSync(path.join(tmpdir(), "openclaw-tts-config-"));
    prefsPath = path.join(dir, "tts.json");
    process.env.OPENCLAW_TTS_PREFS = prefsPath;
  });

  afterEach(() => {
    if (originalPrefsPath === undefined) {
      delete process.env.OPENCLAW_TTS_PREFS;
    } else {
      process.env.OPENCLAW_TTS_PREFS = originalPrefsPath;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips TTS when config, prefs, and session state leave auto mode off", () => {
    expect(shouldAttemptTtsPayload({ cfg: {} as OpenClawConfig })).toBe(false);
  });

  it("honors session auto state before prefs and config", () => {
    writeFileSync(prefsPath, JSON.stringify({ tts: { auto: "off" } }));
    const cfg = { messages: { tts: { auto: "off" } } } as OpenClawConfig;

    expect(shouldAttemptTtsPayload({ cfg, ttsAuto: "always" })).toBe(true);
    expect(shouldAttemptTtsPayload({ cfg, ttsAuto: "off" })).toBe(false);
  });

  it("uses local prefs before config auto mode", () => {
    const cfg = { messages: { tts: { auto: "off" } } } as OpenClawConfig;

    writeFileSync(prefsPath, JSON.stringify({ tts: { enabled: true } }));
    expect(shouldAttemptTtsPayload({ cfg })).toBe(true);

    writeFileSync(prefsPath, JSON.stringify({ tts: { auto: "off" } }));
    expect(
      shouldAttemptTtsPayload({ cfg: { messages: { tts: { enabled: true } } } as OpenClawConfig }),
    ).toBe(false);
  });
});
