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

  it.each([
    "src/agents/github-exec-launcher.ts",
    "src/agents/github-exec-credential.ts",
    "src/shared/worker-bundle-hash.ts",
    "src/worker/workspace-rsync-receiver.ts",
    "src/gateway/worker-environments/workspace-sync.ts",
    "src/gateway/worker-environments/workspace-sync-helpers.ts",
    "src/gateway/worker-environments/workspace-accepted-sync.ts",
    "src/gateway/worker-environments/workspace-accepted-remote-script.ts",
    "src/gateway/worker-environments/workspace-mutation-remote-script.ts",
    "src/gateway/worker-environments/workspace-rsync-path.test.ts",
  ])("routes worker deploy artifact owner %s through macOS CI", (ownerPath) => {
    expect(detectChangedScope([ownerPath])).toMatchObject({
      runNode: true,
      runMacos: true,
    });
  });
});
