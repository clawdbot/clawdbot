import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = "scripts/android-screenshots.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runAndroidScreenshots(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("android screenshots script", () => {
  it("dry-runs with a normalized locale output path", () => {
    const result = runAndroidScreenshots(["--dry-run", "--locale", "pt-BR"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "apps/android/fastlane/metadata/android/pt-BR/images/phoneScreenshots",
    );
    expect(result.stdout).toContain(
      "apps/android/fastlane/metadata/android/pt-BR/images/wearScreenshots",
    );
    expect(result.stdout).toContain(".artifacts/android-screenshots/latest/phone");
    expect(result.stdout).toContain(".artifacts/android-screenshots/latest/wear");
    expect(result.stdout).toContain("Android screenshot size: 1440x2560");
    expect(result.stdout).toContain("Android screenshot size: 454x454");
    expect(result.stdout).toContain("Screenshot AVD: OpenClaw_Screenshots_API36");
    expect(result.stdout).toContain("Screenshot AVD: OpenClaw_Wear_Screenshots_API34");
    expect(result.stdout).toContain("Screenshot device profile: pixel_2");
    expect(result.stdout).toContain("Screenshot device profile: wearos_large_round");
    expect(result.stdout).toContain("Scenes: home chat settings gateway voice-wake");
    expect(result.stdout).toContain("Scenes: chat voice controls");
    expect(result.stdout).not.toContain("connect chat voice screen settings");
    expect(result.stdout).toContain("Dry run complete.");
  });

  it("keeps artifact cleanup inside the repository-owned evidence directory", () => {
    const result = runAndroidScreenshots(["--dry-run"], {
      ANDROID_SCREENSHOT_ARTIFACT_DIR: process.env.HOME,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(".artifacts/android-screenshots/latest");
    expect(result.stdout).not.toContain(`Android screenshot artifacts: ${process.env.HOME}\n`);
  });

  it("keeps fixture readiness and device restoration aligned", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const fixture = readFileSync(
      "apps/android/app/src/main/java/ai/openclaw/app/AndroidScreenshotFixture.kt",
      "utf8",
    );
    const chatReady = "Draft a short status update for the team.";

    expect(fixture).toContain(`"${chatReady}"`);
    expect(script).toContain(`chat) printf '%s\\n' "${chatReady}"`);
    for (const marker of [
      'shell wm density "$ORIGINAL_WM_DENSITY"',
      "shell wm density reset",
      'shell cmd alarm set-timezone "$ORIGINAL_TIME_ZONE"',
      'shell cmd time_zone_detector set_auto_detection_enabled "$ORIGINAL_AUTO_TIME_ZONE"',
      "com.google.android.wearable.sysui:id/charging_container",
      "shell input keyevent 4",
    ]) {
      expect(script).toContain(marker);
    }
  });

  it("rejects a physical device selected during screenshot discovery", () => {
    const root = tempDirs.make("openclaw-android-screenshot-adb-");
    const adb = path.join(root, "adb");
    writeFileSync(
      adb,
      `#!/usr/bin/env bash
if [[ "$1" == "devices" ]]; then
  printf 'List of devices attached\\nphysical-serial\\tdevice\\n'
  exit 0
fi
if [[ "$1" == "-s" && "$2" == "physical-serial" && "$3" == "emu" && "$4" == "avd" && "$5" == "name" ]]; then
  exit 1
fi
if [[ "$1" == "-s" && "$2" == "physical-serial" && "$3" == "shell" && "$4" == "getprop" && "$5" == "ro.kernel.qemu" ]]; then
  printf '0\\n'
  exit 0
fi
printf 'unexpected adb invocation: %s\\n' "$*" >&2
exit 97
`,
      "utf8",
    );
    chmodSync(adb, 0o755);

    const result = runAndroidScreenshots(
      ["--form-factor", "phone", "--skip-build", "--skip-install"],
      { ADB: adb },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Android screenshot capture requires an emulator; 'physical-serial' is not an emulator.",
    );
    expect(result.stderr).toContain("Pass --avd <name> or --device <emulator-serial>.");
    expect(result.stderr).not.toContain("Connected emulator 'unknown'");
    expect(result.stderr).not.toContain("unexpected adb invocation");
  });

  it.each(["../escape", "en/US", ".hidden", "en..US", ""])(
    "rejects locale path escapes before dry-run output: %j",
    (locale) => {
      const result = runAndroidScreenshots(["--dry-run", "--locale", locale]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Invalid Android screenshot locale");
      expect(result.stderr).toContain("path separators and dot segments are not allowed");
      expect(result.stdout).not.toContain("Android screenshot output:");
    },
  );

  it("rejects screenshot dimensions outside Google Play's aspect-ratio limit", () => {
    const result = runAndroidScreenshots(["--dry-run"], {
      ANDROID_SCREENSHOT_SIZE: "1080x2424",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not meet Google Play dimension and aspect-ratio limits");
  });

  it("requires a form factor when selecting one emulator explicitly", () => {
    const result = runAndroidScreenshots(["--dry-run", "--avd", "custom"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--device and --avd require --form-factor phone or --form-factor wear",
    );
  });

  it("requires one form factor when retaining an emulator", () => {
    const result = runAndroidScreenshots(["--dry-run", "--keep-emulator"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--keep-emulator requires --form-factor phone or --form-factor wear",
    );
  });
});
