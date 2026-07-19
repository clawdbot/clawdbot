import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/android-screenshots.sh";
const SCREENSHOT_FIXTURE =
  "apps/android/app/src/main/java/ai/openclaw/app/AndroidScreenshotFixture.kt";

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
    expect(result.stdout).toContain(".artifacts/android-screenshots/latest");
    expect(result.stdout).toContain("Android screenshot size: 1440x2560");
    expect(result.stdout).toContain("Screenshot AVD: OpenClaw_Screenshots_API36");
    expect(result.stdout).toContain("Screenshot device profile: pixel_2");
    expect(result.stdout).toContain("Scenes: home chat voice settings gateway");
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

  it("waits for fixture content unique to the chat, settings, and gateway screens", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const fixture = readFileSync(SCREENSHOT_FIXTURE, "utf8");

    expect(script).toContain("chat) printf '%s\\n' \"Draft a short status update for the team.\"");
    expect(script).not.toContain("chat) printf '%s\\n' \"Ready when you are\"");
    expect(fixture).toContain('"Draft a short status update for the team."');
    expect(script).toContain("settings) printf '%s\\n' \"OpenClaw mobile\"");
    expect(script).not.toContain("settings) printf '%s\\n' \"Settings\"");
    expect(script).toContain(
      "gateway) printf '%s\\n' \"Connection between this phone and OpenClaw.\"",
    );
    expect(script).not.toContain("gateway) printf '%s\\n' \"Add Gateway\"");
  });

  it("scales and restores display density with the screenshot size", () => {
    const script = readFileSync(SCRIPT, "utf8");

    expect(script).toContain('SCREENSHOT_SIZE="${ANDROID_SCREENSHOT_SIZE:-1440x2560}"');
    expect(script).toContain('shell wm density "$SCREENSHOT_DENSITY"');
    expect(script).toContain('shell wm density "$ORIGINAL_WM_DENSITY"');
    expect(script).toContain("shell wm density reset");
  });

  it("pins the device timezone before rendering seeded timestamps", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const requireEmulatorIndex = script.indexOf('require_emulator_device "$ADB_BIN" "$ADB_SERIAL"');
    const stabilizeDeviceIndex = script.indexOf(
      'stabilize_device_for_screenshots "$ADB_BIN" "$ADB_SERIAL"',
    );

    expect(script).toContain("shell cmd time_zone_detector set_auto_detection_enabled false");
    expect(script).toContain("shell cmd alarm set-timezone UTC");
    expect(script).toContain('shell cmd alarm set-timezone "$ORIGINAL_TIME_ZONE"');
    expect(script).toContain(
      'shell cmd time_zone_detector set_auto_detection_enabled "$ORIGINAL_AUTO_TIME_ZONE"',
    );
    expect(requireEmulatorIndex).toBeGreaterThan(-1);
    expect(stabilizeDeviceIndex).toBeGreaterThan(requireEmulatorIndex);
  });

  it("provisions a retained no-cutout screenshot emulator by default", () => {
    const script = readFileSync(SCRIPT, "utf8");

    expect(script).toContain('DEFAULT_SCREENSHOT_AVD="OpenClaw_Screenshots_API36"');
    expect(script).toContain('DEFAULT_SCREENSHOT_DEVICE_PROFILE="pixel_2"');
    expect(script).toContain('ensure_screenshot_avd "$avd"');
    expect(script).toContain('--device "$SCREENSHOT_DEVICE_PROFILE"');
    expect(script).toContain("is not the screenshot AVD");
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
});
