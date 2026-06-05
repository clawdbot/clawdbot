import { describe, expect, it } from "vitest";
import {
  linuxArmAndroidGradleSkipMessage,
  shouldSkipLinuxArmAndroidGradle,
  splitAndroidGradleArgs,
} from "../../scripts/run-android-gradle.mjs";

describe("run-android-gradle", () => {
  it("splits Gradle args from an optional post command", () => {
    expect(
      splitAndroidGradleArgs([":app:installPlayDebug", "--", "adb", "shell", "am", "start"]),
    ).toEqual({
      gradleArgs: [":app:installPlayDebug"],
      postArgs: ["adb", "shell", "am", "start"],
    });
  });

  it("skips Linux ARM hosts by default because AAPT2 is x86_64-only", () => {
    expect(shouldSkipLinuxArmAndroidGradle({ arch: "arm64", platform: "linux" })).toBe(true);
    expect(shouldSkipLinuxArmAndroidGradle({ arch: "arm", platform: "linux" })).toBe(true);
    expect(shouldSkipLinuxArmAndroidGradle({ arch: "x64", platform: "linux" })).toBe(false);
    expect(shouldSkipLinuxArmAndroidGradle({ arch: "arm64", platform: "darwin" })).toBe(false);
  });

  it("allows an explicit Linux ARM override", () => {
    expect(
      shouldSkipLinuxArmAndroidGradle({
        arch: "arm64",
        env: { OPENCLAW_ANDROID_GRADLE_ALLOW_LINUX_ARM: "1" },
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("explains the skip with the override escape hatch", () => {
    expect(linuxArmAndroidGradleSkipMessage("linux", "arm64")).toContain(
      "OPENCLAW_ANDROID_GRADLE_ALLOW_LINUX_ARM=1",
    );
  });
});
