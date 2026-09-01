import { describe, expect, it } from "vitest";
import { detectChangedScope } from "../../scripts/ci-changed-scope.mjs";

describe("shared native contract fixture CI scope", () => {
  it("runs macOS contract tests for the device identity fixture", () => {
    const fixturePath = "test/fixtures/device-identity-coordinator-contract.json";
    expect(detectChangedScope([fixturePath])).toEqual({
      runNode: true,
      runMacos: true,
      runMacosNode: true,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("runs Android and macOS contract tests for the shared Talk fixture", () => {
    const fixturePath = "test/fixtures/talk-config-contract.json";
    expect(detectChangedScope([fixturePath])).toEqual({
      runNode: true,
      runMacos: true,
      runMacosNode: true,
      runIosBuild: false,
      runAndroid: true,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it.each([
    "src/shared/worker-bundle-hash.ts",
    "src/worker/workspace-rsync-receiver.ts",
    "src/gateway/worker-environments/workspace-sync.ts",
    "src/gateway/worker-environments/workspace-sync-helpers.ts",
    "src/gateway/worker-environments/workspace-accepted-sync.ts",
    "src/gateway/worker-environments/workspace-accepted-remote-script.ts",
    "src/gateway/worker-environments/workspace-mutation-remote-script.ts",
    "src/gateway/worker-environments/workspace-rsync-path.test.ts",
  ])("routes workspace rsync receiver owner %s through macOS CI", (ownerPath) => {
    expect(detectChangedScope([ownerPath])).toMatchObject({
      runNode: true,
      runMacos: true,
    });
  });
});
