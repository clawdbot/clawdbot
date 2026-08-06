import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  linuxArmAndroidGradleSkipMessage,
  resolveAndroidSdkEnv,
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

  describe("resolveAndroidSdkEnv", () => {
    const macSdk = path.join("/Users/dev", "Library", "Android", "sdk");
    const linuxSdk = path.join("/home/dev", "Android", "Sdk");

    it("keeps env untouched when ANDROID_HOME or ANDROID_SDK_ROOT is set", () => {
      const env = { ANDROID_HOME: "/opt/sdk" };
      expect(resolveAndroidSdkEnv({ env, existsSync: () => true })).toBe(env);
      const rootEnv = { ANDROID_SDK_ROOT: "/opt/sdk" };
      expect(resolveAndroidSdkEnv({ env: rootEnv, existsSync: () => true })).toBe(rootEnv);
    });

    it("keeps env untouched when local.properties exists", () => {
      const env = {};
      const result = resolveAndroidSdkEnv({
        env,
        existsSync: (p: string) => p.endsWith("local.properties"),
        homeDir: "/Users/dev",
        platform: "darwin",
      });
      expect(result).toBe(env);
    });

    it("falls back to the Android Studio default SDK path per platform", () => {
      const darwin = resolveAndroidSdkEnv({
        env: {},
        existsSync: (p: string) => p === macSdk,
        homeDir: "/Users/dev",
        platform: "darwin",
      });
      expect(darwin.ANDROID_HOME).toBe(macSdk);
      const linux = resolveAndroidSdkEnv({
        env: {},
        existsSync: (p: string) => p === linuxSdk,
        homeDir: "/home/dev",
        platform: "linux",
      });
      expect(linux.ANDROID_HOME).toBe(linuxSdk);
    });

    it("keeps env untouched when no default SDK install exists", () => {
      const env = {};
      const result = resolveAndroidSdkEnv({
        env,
        existsSync: () => false,
        homeDir: "/Users/dev",
        platform: "darwin",
      });
      expect(result).toBe(env);
    });
  });
});
