import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot } from "./config.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import { validateConfigObject } from "./validation.js";

describe("legacy provider-shaped config snapshots", () => {
  it("accepts a string map of voice aliases while still flagging legacy talk config", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        talk: {
          voiceAliases: {
            Clawd: "VoiceAlias1234567890",
            Roger: "CwhRBWXzGAHq8TQ4Fs17",
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "talk")).toBe(true);
      expect(snap.sourceConfig.talk?.providers?.elevenlabs?.voiceAliases).toEqual({
        Clawd: "VoiceAlias1234567890",
        Roger: "CwhRBWXzGAHq8TQ4Fs17",
      });
    });
  });

  it("rejects non-string voice alias values", () => {
    const res = validateConfigObject({
      talk: {
        voiceAliases: {
          Clawd: 123,
        },
      },
    });
    expect(res.ok).toBe(false);
  });
});
