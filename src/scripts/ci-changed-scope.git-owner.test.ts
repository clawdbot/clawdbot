// Git-owner scope tests keep lifecycle owners on native process proof lanes.
import { describe, expect, it } from "vitest";

const { detectChangedScope } = await import("../../scripts/ci-changed-scope.mjs");

describe("detectChangedScope Git-owner routing", () => {
  it.each([
    ".github/actions/publish-generated-pr/action.yml",
    ".github/actions/publish-generated-pr/policy.py",
    ".github/workflows/maturity-scorecard.yml",
    "test/scripts/generated-publisher.test-support.ts",
    ".github/actions/git-owner/action.yml",
    ".github/workflows/workflow-sanity.yml",
    ".github/workflows/qa-profile-evidence.yml",
    ".github/workflows/docs-sync-publish.yml",
    ".github/workflows/docs-agent.yml",
    ".github/workflows/openclaw-performance.yml",
    ".github/workflows/linux-app-release.yml",
    ".github/workflows/macos-release.yml",
    ".github/workflows/npm-placeholder-bootstrap.yml",
    ".github/workflows/plugin-clawhub-release.yml",
    ".github/workflows/plugin-npm-release.yml",
    ".github/actions/mantis-validate-trusted-ref/action.yml",
    ".github/workflows/mantis-discord-smoke.yml",
    ".github/workflows/mantis-discord-status-reactions.yml",
    ".github/workflows/mantis-discord-thread-attachment.yml",
    ".github/workflows/mantis-slack-desktop-smoke.yml",
    ".github/workflows/mantis-web-ui-chat-proof.yml",
    ".github/actions/git-owner/owner.py",
    ".github/actions/ensure-base-commit/action.yml",
    ".github/actions/ensure-base-commit/policy.py",
    "scripts/generate-ci-git-owner.mts",
    "test/scripts/ci-checkout.test-support.ts",
    "test/scripts/ci-git-owner.test.ts",
    "test/scripts/ci-git-owner.test-support.ts",
    "test/scripts/ci-linux-git.test.ts",
    "test/scripts/ci-platform-checkout.test.ts",
    "test/scripts/ci-windows-process-census.test-support.ts",
    "test/scripts/openclaw-performance-git-lifecycle.test.ts",
    "test/scripts/openclaw-performance-workflow.test-support.ts",
    "test/scripts/openclaw-performance-workflow.test.ts",
    "test/scripts/plugin-release-git-lifecycle.test.ts",
    "test/scripts/release-workflow-git-lifecycle.test.ts",
    "test/scripts/fixtures/ci-platform-checkout.mjs",
    "test/scripts/fixtures/ci-windows-process-census.mjs",
    "test/scripts/fixtures/ci-windows-process-census.py",
  ])("routes native proof for %s without selecting app builds", (changedPath) => {
    expect(detectChangedScope([changedPath])).toMatchObject({
      runNode: true,
      runMacosNode: true,
      runWindows: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
    });
  });
});
