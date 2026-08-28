// macOS CI scope tests cover the Darwin-only packaging scripts, their shared libraries, and their
// owner tests, which route to the macOS runner rather than the Node lane.
import { describe, expect, it } from "vitest";

const { detectChangedScope } = await import("../../scripts/ci-changed-scope.mjs");

describe("detectChangedScope macOS routing", () => {
  it("runs macOS CI for macOS packaging scripts with Darwin-only tests", () => {
    for (const changedPath of [
      "scripts/codesign-mac-app.sh",
      "scripts/create-dmg.sh",
      "scripts/lib/mac-signing-identity.sh",
      "scripts/lib/plistbuddy.sh",
      "scripts/lib/swift-toolchain.sh",
      "scripts/notarize-mac-artifact.sh",
      "scripts/package-mac-app.sh",
      "scripts/package-mac-dist.sh",
    ]) {
      expect(detectChangedScope([changedPath])).toEqual({
        runNode: true,
        runMacos: true,
        runIosBuild: false,
        runAndroid: false,
        runWindows: false,
        runSkillsPython: false,
        runChangedSmoke: false,
        runControlUiI18n: false,
        runUiTests: false,
      });
    }
  });

  it("runs macOS CI for Darwin-only mac packaging owner tests", () => {
    for (const changedPath of [
      "test/scripts/codesign-mac-app.test.ts",
      "test/scripts/create-dmg.test.ts",
      "test/scripts/notarize-mac-artifact.test.ts",
      "test/scripts/package-mac-app.test.ts",
      "test/scripts/package-mac-dist.test.ts",
    ]) {
      expect(detectChangedScope([changedPath])).toEqual({
        runNode: true,
        runMacos: true,
        runIosBuild: false,
        runAndroid: false,
        runWindows: false,
        runSkillsPython: false,
        runChangedSmoke: false,
        runControlUiI18n: false,
        runUiTests: false,
      });
    }
  });
});
