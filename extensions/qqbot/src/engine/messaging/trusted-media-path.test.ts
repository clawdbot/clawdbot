// Qqbot tests cover trusted outbound media-path root resolution.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOutboundMediaPath } from "./outbound-media-send.js";
import { resolveTrustedOutboundMediaPath } from "./trusted-media-path.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }
});

function makeTtsStyleVoiceFile(): string {
  // Mirrors cron auto-TTS: speech-core writes the voice file under the preferred
  // OpenClaw temp root, which is outside the QQ Bot media storage tree.
  const tmpRoot = resolvePreferredOpenClawTmpDir();
  const ttsDir = makeTrackedDir(tmpRoot, "tts-");
  const voicePath = path.join(ttsDir, "voice-123.mp3");
  fs.writeFileSync(voicePath, "audio");
  return voicePath;
}

function makeTrackedDir(parentDir: string, prefix: string): string {
  const dir = path.join(parentDir, `${prefix}${randomUUID()}`);
  fs.mkdirSync(dir);
  cleanupPaths.push(dir);
  return dir;
}

describe("resolveTrustedOutboundMediaPath", () => {
  it("trusts framework media under OpenClaw's hardened temp root", () => {
    const voicePath = makeTtsStyleVoiceFile();
    expect(resolveTrustedOutboundMediaPath(voicePath)).toBe(fs.realpathSync(voicePath));
  });

  it("rejects local media outside every trusted root", () => {
    const outsideDir = makeTrackedDir(os.tmpdir(), "qq-out-of-root-");
    const strayPath = path.join(outsideDir, "stray.mp3");
    fs.writeFileSync(strayPath, "audio");

    expect(resolveTrustedOutboundMediaPath(strayPath)).toBeNull();
  });

  it("accepts a not-yet-flushed temp file only when allowMissing is set", () => {
    const tmpRoot = resolvePreferredOpenClawTmpDir();
    const ttsDir = makeTrackedDir(tmpRoot, "tts-pending-");
    const pendingPath = path.join(ttsDir, "voice-pending.mp3");

    expect(resolveTrustedOutboundMediaPath(pendingPath)).toBeNull();
    expect(resolveTrustedOutboundMediaPath(pendingPath, { allowMissing: true })).not.toBeNull();
  });
});

describe("resolveOutboundMediaPath", () => {
  it("resolves a cron/TTS voice file under the temp root end to end", () => {
    // Both the initial resolve and the voice send re-check funnel through
    // resolveTrustedOutboundMediaPath, so this gate now passes for temp media.
    const voicePath = makeTtsStyleVoiceFile();
    const resolved = resolveOutboundMediaPath(voicePath, "voice", {
      allowMissingLocalPath: true,
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.mediaPath).toBe(fs.realpathSync(voicePath));
  });
});
