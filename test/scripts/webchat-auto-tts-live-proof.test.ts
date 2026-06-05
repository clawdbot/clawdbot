// Webchat Auto Tts Live Proof tests cover webchat auto tts live proof script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupProofArtifacts } from "../../scripts/repro/webchat-auto-tts-live-proof.mjs";

describe("webchat auto TTS live proof", () => {
  it("cleans generated media and prefs artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-webchat-tts-proof-test-"));
    const mediaDir = path.join(root, "media");
    const mediaPath = path.join(mediaDir, "voice.ogg");
    const prefsPath = path.join(root, "prefs.json");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(mediaPath, "voice");
    fs.writeFileSync(prefsPath, "{}\n");

    cleanupProofArtifacts({ mediaPath, prefsPath });

    expect(fs.existsSync(mediaDir)).toBe(false);
    expect(fs.existsSync(prefsPath)).toBe(false);
    cleanupProofArtifacts({ mediaPath, prefsPath });
    fs.rmSync(root, { force: true, recursive: true });
  });
});
