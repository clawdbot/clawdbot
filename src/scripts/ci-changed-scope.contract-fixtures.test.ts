import { describe, expect, it } from "vitest";
import { detectChangedScope } from "../../scripts/ci-changed-scope.mjs";

describe("shared Apple contract fixture CI scope", () => {
  it.each([
    "test/fixtures/device-identity-coordinator-contract.json",
    "test/fixtures/talk-config-contract.json",
  ])("runs macOS contract tests for %s", (fixturePath) => {
    expect(detectChangedScope([fixturePath])).toEqual({
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
  });
});
