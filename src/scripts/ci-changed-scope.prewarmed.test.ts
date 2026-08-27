import { describe, expect, it } from "vitest";

const { detectChangedScope } = await import("../../scripts/ci-changed-scope.mjs");

describe("prewarmed plugin cache CI scope", () => {
  it("routes cache implementation and tests through macOS CI", () => {
    for (const changedPath of [
      "scripts/prewarmed-plugin-cache.mjs",
      "scripts/stage-macos-prewarmed-plugin-cache.mts",
      "test/scripts/prewarmed-plugin-cache.test.ts",
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
