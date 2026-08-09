// CI changed scope tests cover script detection of changed files and lanes.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";

const {
  detectChangedScope,
  detectInstallSmokeScope,
  detectNodeFastScope,
  listChangedPaths,
  parseArgs,
  shouldRunNativeI18n,
  writeGitHubOutput,
} = await import("../../scripts/ci-changed-scope.mjs");

const markerPaths: string[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const markerPath of markerPaths) {
    try {
      fs.unlinkSync(markerPath);
    } catch {}
  }
  markerPaths.length = 0;
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
  tempDirs.length = 0;
});

function parseGitHubOutput(output: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of output.trim().split("\n")) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf("=");
    parsed[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return parsed;
}

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
}

function writeRepoFile(repoDir: string, filePath: string, contents: string): void {
  const absolutePath = path.join(repoDir, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, "utf8");
}

function createSyntheticMergeRepo(prefix: string): { repoDir: string; staleBase: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(repoDir);

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "ci@example.invalid"]);
  git(repoDir, ["config", "user.name", "CI"]);
  writeRepoFile(repoDir, "README.md", "base\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "base"]);
  const staleBase = git(repoDir, ["rev-parse", "HEAD"]);

  git(repoDir, ["switch", "-c", "feature"]);
  writeRepoFile(repoDir, "src/pr.ts", "export const pr = true;\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "feature"]);

  git(repoDir, ["switch", "main"]);
  writeRepoFile(repoDir, "src/main-only.ts", "export const mainOnly = true;\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "main only"]);
  git(repoDir, ["merge", "--no-ff", "feature", "-m", "synthetic merge"]);

  return { repoDir, staleBase };
}

describe("parseArgs", () => {
  it("parses CI diff refs", () => {
    expect(parseArgs(["--base", "origin/main", "--head", "HEAD"])).toEqual({
      base: "origin/main",
      head: "HEAD",
      mergeHeadFirstParent: false,
    });
  });

  it("rejects missing CI diff refs", () => {
    expect(() => parseArgs(["--base", "--head", "HEAD"])).toThrow("--base requires a value");
    expect(() => parseArgs(["--base", "-h", "--head", "HEAD"])).toThrow("--base requires a value");
    expect(() => parseArgs(["--head"])).toThrow("--head requires a value");
    expect(() => parseArgs(["--head", "-h"])).toThrow("--head requires a value");
    expect(() => parseArgs(["--base", ""])).toThrow("--base requires a value");
  });
});

describe("detectChangedScope", () => {
  it("routes only native i18n-owned paths to the native inventory job", () => {
    for (const changedPath of [
      "apps/.i18n/native-source.json",
      "apps/android/app/src/main/java/ai/openclaw/app/MainActivity.kt",
      "apps/android/wear/src/main/java/ai/openclaw/wear/WearScreens.kt",
      "apps/ios/Sources/RootTabs.swift",
      "apps/macos/Sources/OpenClaw/Settings.swift",
      "apps/shared/OpenClawKit/Sources/OpenClawKit/Client.swift",
      "scripts/native-app-i18n.ts",
      "scripts/android-app-i18n.ts",
      "scripts/apple-app-i18n.ts",
      "test/scripts/native-app-i18n.test.ts",
      ".github/workflows/native-app-locale-refresh.yml",
      ".github/workflows/ci.yml",
    ]) {
      expect(shouldRunNativeI18n([changedPath]), changedPath).toBe(true);
    }

    expect(shouldRunNativeI18n(["src/config/defaults.ts"])).toBe(false);
    expect(shouldRunNativeI18n(["scripts/install.sh"])).toBe(false);
  });

  it("fails safe when no paths are provided", () => {
    expect(detectChangedScope([])).toEqual({
      runNode: true,
      runMacos: true,
      runIosBuild: true,
      runAndroid: true,
      runWindows: true,
      runSkillsPython: true,
      runChangedSmoke: true,
      runControlUiI18n: true,
      runUiTests: true,
    });
  });

  it("keeps all lanes off for docs-only changes", () => {
    expect(detectChangedScope(["docs/ci.md", "README.md"])).toEqual({
      runNode: false,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("enables node lane for node-relevant files", () => {
    expect(detectChangedScope(["src/config/defaults.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("keeps node lane off for native-only changes", () => {
    expect(detectChangedScope(["apps/macos/Sources/Foo.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(
      detectChangedScope(["apps/macos-mlx-tts/Sources/OpenClawMLXTTSHelper/main.swift"]),
    ).toEqual({
      runNode: false,
      runMacos: true,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["apps/ios/Sources/RootTabs.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runIosBuild: true,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["apps/shared/OpenClawKit/Sources/Foo.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runIosBuild: true,
      runAndroid: true,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["apps/swabble/Sources/SwabbleKit/WakeWordGate.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runIosBuild: true,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["Swabble/Sources/SwabbleKit/WakeWordGate.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runIosBuild: true,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("runs both Apple lanes for shared Swift tooling changes", () => {
    for (const toolingPath of [
      "config/swiftformat",
      "config/swiftlint.yml",
      "scripts/check-swift-tools.sh",
      "scripts/format-swift.sh",
      "scripts/install-swift-tools.sh",
      "scripts/install-xcodegen.sh",
      "scripts/lint-swift.sh",
    ]) {
      expect(detectChangedScope([toolingPath])).toEqual({
        runNode: true,
        runMacos: true,
        runIosBuild: true,
        runAndroid: false,
        runWindows: false,
        runSkillsPython: false,
        runChangedSmoke: false,
        runControlUiI18n: false,
        runUiTests: false,
      });
    }
  });

  it("enables the iOS build lane for iOS build helper changes", () => {
    for (const helperPath of [
      "scripts/ios-team-id.sh",
      "scripts/ios-write-swift-filelist.mjs",
      "scripts/ios-write-swift-filelist.mts",
      "scripts/ios-version.ts",
      "scripts/lib/ios-version.ts",
      "scripts/lib/release-version.mjs",
      "scripts/lib/version-script-args.ts",
    ]) {
      expect(detectChangedScope([helperPath])).toEqual({
        runNode: true,
        runMacos: false,
        runIosBuild: true,
        runAndroid: false,
        runWindows: false,
        runSkillsPython: false,
        runChangedSmoke: false,
        runControlUiI18n: false,
        runUiTests: false,
      });
    }
  });

  it("runs the iOS build but not macOS for generated protocol model-only changes", () => {
    expect(
      detectChangedScope(["apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift"]),
    ).toEqual({
      runNode: false,
      runMacos: false,
      runIosBuild: true,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("enables node lane for non-native non-doc files by fallback", () => {
    expect(detectChangedScope(["README.md"])).toEqual({
      runNode: false,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });

    expect(detectChangedScope([".crabbox.yaml"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("keeps windows lane off for non-runtime GitHub metadata files", () => {
    expect(detectChangedScope([".github/labeler.yml"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("runs Python skill tests when skills change", () => {
    expect(detectChangedScope(["skills/skill-creator/scripts/test_quick_validate.py"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: true,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("runs Python skill tests when shared Python config changes", () => {
    expect(detectChangedScope(["skills/pyproject.toml"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: true,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("runs CI-owned platform lanes when the CI workflow changes", () => {
    expect(detectChangedScope([".github/workflows/ci.yml"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: true,
    });
  });

  it("runs macOS CI for macOS packaging scripts with Darwin-only tests", () => {
    for (const changedPath of [
      "scripts/codesign-mac-app.sh",
      "scripts/create-dmg.sh",
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

  it("runs Windows only for Windows-relevant changes", () => {
    expect(detectChangedScope(["extensions/memory-lancedb/index.test.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["src/auto-reply/reply/streaming-directives.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["src/process/exec.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["src/process/exec.windows.test.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    for (const daemonPath of [
      "src/daemon/schtasks.ts",
      "src/daemon/schtasks-exec.ts",
      "src/daemon/schtasks.startup-fallback.test.ts",
      "src/daemon/runtime-hints.windows-paths.test.ts",
      "src/daemon/test-helpers/schtasks-fixtures.ts",
    ]) {
      expect(detectChangedScope([daemonPath]), daemonPath).toEqual({
        runNode: true,
        runMacos: false,
        runIosBuild: false,
        runAndroid: false,
        runWindows: true,
        runSkillsPython: false,
        runChangedSmoke: false,
        runControlUiI18n: false,
        runUiTests: false,
      });
    }
    expect(detectChangedScope(["src/shared/runtime-import.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["src/shared/runtime-import.test.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["scripts/npm-runner.mts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["scripts/lib/format-generated-module.mts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["test/scripts/format-generated-module.test.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    for (const releaseCheckPath of [
      ".github/workflows/openclaw-cross-os-release-checks-reusable.yml",
      "scripts/github/run-openclaw-cross-os-release-checks.sh",
      "scripts/openclaw-cross-os-release-checks.ts",
      "scripts/lib/cross-os-release-checks/runtime.ts",
      "test/scripts/openclaw-cross-os-release-workflow.test.ts",
    ]) {
      expect(detectChangedScope([releaseCheckPath]), releaseCheckPath).toEqual({
        runNode: true,
        runMacos: false,
        runIosBuild: false,
        runAndroid: false,
        runWindows: true,
        runSkillsPython: false,
        runChangedSmoke: false,
        runControlUiI18n: false,
        runUiTests: false,
      });
    }
    expect(detectChangedScope(["scripts/install.ps1"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("runs changed-smoke for install and packaging surfaces", () => {
    expect(detectChangedScope(["scripts/install.sh"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["scripts/install-cli.sh"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope([bundledPluginFile("matrix", "package.json")])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope([".github/workflows/install-smoke.yml"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["scripts/e2e/qr-import-docker.sh"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["scripts/e2e/gateway-network-docker.sh"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["scripts/e2e/Dockerfile"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["scripts/e2e/agents-delete-shared-workspace-docker.sh"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["scripts/e2e/plugin-update-unchanged-docker.sh"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["scripts/postinstall-bundled-plugins.mjs"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["scripts/ci-changed-scope.mjs"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("runs changed-smoke for Docker-covered core runtime surfaces", () => {
    expect(detectChangedScope(["src/plugins/loader.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["src/plugin-sdk/provider-entry.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["packages/gateway-protocol/src/schema/messages.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["packages/gateway-client/src/client.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope(["src/channels/plugins/catalog.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope([bundledPluginFile("matrix", "index.ts")])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("splits install smoke into fast and full scopes", () => {
    expect(detectInstallSmokeScope([])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: true,
    });
    expect(detectInstallSmokeScope(["docs/ci.md"])).toEqual({
      runFastInstallSmoke: false,
      runFullInstallSmoke: false,
    });
    expect(detectInstallSmokeScope(["scripts/install.sh"])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: true,
    });
    expect(detectInstallSmokeScope(["scripts/install-cli.sh"])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: true,
    });
    expect(detectInstallSmokeScope(["scripts/install.ps1"])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: true,
    });
    expect(detectInstallSmokeScope(["Dockerfile"])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: true,
    });
    expect(detectInstallSmokeScope([bundledPluginFile("matrix", "package.json")])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: false,
    });
    expect(detectInstallSmokeScope(["src/plugins/loader.ts"])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: false,
    });
    expect(detectInstallSmokeScope(["packages/gateway-client/src/client.ts"])).toEqual({
      runFastInstallSmoke: true,
      runFullInstallSmoke: false,
    });
    expect(detectInstallSmokeScope([bundledPluginFile("matrix", "index.ts")])).toEqual({
      runFastInstallSmoke: false,
      runFullInstallSmoke: false,
    });
  });

  it("keeps changed-smoke off for runtime-surface tests", () => {
    expect(detectChangedScope(["src/plugins/loader.test.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
    expect(detectChangedScope([bundledPluginFile("matrix", "index.test.ts")])).toEqual({
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
      runUiTests: false,
    });
  });

  it("runs control-ui locale check only for control-ui i18n surfaces", () => {
    const expected = {
      runNode: true,
      runMacos: false,
      runIosBuild: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: true,
      runUiTests: true,
    };
    expect(detectChangedScope(["ui/src/i18n/locales/en.ts"])).toEqual(expected);

    for (const scriptPath of [
      "scripts/control-ui-i18n.ts",
      "scripts/control-ui-i18n-verify.ts",
      "scripts/lib/control-ui-i18n-catalog.ts",
      "scripts/lib/control-ui-i18n-raw-copy.ts",
      "scripts/lib/control-ui-i18n-sync-plan.ts",
    ]) {
      expect(detectChangedScope([scriptPath])).toEqual({ ...expected, runUiTests: false });
    }
  });

  it.each([
    "ui/src/pages/chat/chat-realtime.test.ts",
    "ui/package.json",
    "test/vitest/vitest.shared.config.ts",
    "scripts/ensure-playwright-chromium.mts",
  ])("runs control-ui tests for %s", (changedPath) => {
    expect(detectChangedScope([changedPath]).runUiTests).toBe(true);
  });

  it("identifies plugin contract helper changes as fast Node-only CI scope", () => {
    const bundledCapabilityMetadataPath = [
      "src/plugins/contracts",
      "inventory/bundled-capability-metadata.ts",
    ].join("/");
    expect(
      detectNodeFastScope([
        bundledCapabilityMetadataPath,
        "src/plugins/contracts/registry.ts",
        "src/plugins/contracts/tts-contract-suites.ts",
        "scripts/test-projects.test-support.mts",
        "test/scripts/test-projects.test.ts",
      ]),
    ).toEqual({
      runFastOnly: true,
      runPluginContracts: true,
      runCiRouting: true,
    });
  });

  it("identifies CI routing changes as fast Node-only CI scope", () => {
    expect(
      detectNodeFastScope([
        "scripts/check-changed.mjs",
        "scripts/ci-changed-scope.mjs",
        "scripts/run-vitest.mts",
        "scripts/test-projects.test-support.mts",
        "src/commands/status.scan-result.test.ts",
        "src/scripts/ci-changed-scope.control-ui.test.ts",
        "src/scripts/ci-changed-scope.native-i18n.test.ts",
        "src/scripts/ci-changed-scope.test.ts",
        "src/scripts/ci-changed-scope.windows.test.ts",
        "test/scripts/changed-lanes.test.ts",
        "test/scripts/run-vitest.test.ts",
        "test/scripts/test-projects.test.ts",
        "docs/ci.md",
      ]),
    ).toEqual({
      runFastOnly: true,
      runPluginContracts: false,
      runCiRouting: true,
    });
  });

  it("keeps CI workflow edits off fast-only scope so native lanes can run", () => {
    expect(detectNodeFastScope([".github/workflows/ci.yml"])).toEqual({
      runFastOnly: false,
      runPluginContracts: false,
      runCiRouting: false,
    });
  });

  it("keeps broad source changes on the full Node CI scope", () => {
    expect(
      detectNodeFastScope([
        "src/plugins/contracts/manifest-loader.ts",
        "src/plugins/contracts/registry.ts",
      ]),
    ).toEqual({
      runFastOnly: false,
      runPluginContracts: false,
      runCiRouting: false,
    });
  });

  it("treats base and head as literal git args", () => {
    const markerPath = path.join(
      os.tmpdir(),
      `openclaw-ci-changed-scope-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    markerPaths.push(markerPath);

    const injectedBase =
      process.platform === "win32"
        ? `HEAD & echo injected > "${markerPath}" & rem`
        : `HEAD; touch "${markerPath}" #`;

    let error: unknown;
    try {
      listChangedPaths(injectedBase, "HEAD");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(injectedBase);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("uses the merge commit first parent instead of a stale PR payload base", () => {
    const { repoDir, staleBase } = createSyntheticMergeRepo("openclaw-ci-scope-merge-");

    expect(
      execFileSync("git", ["diff", "--name-only", staleBase, "HEAD"], {
        cwd: repoDir,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .toSorted(),
    ).toEqual(["src/main-only.ts", "src/pr.ts"]);

    expect(listChangedPaths(staleBase, "HEAD", repoDir, true)).toEqual(["src/pr.ts"]);
  });

  it("reports both sides of a rename so deleted paths force safe planning", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ci-scope-rename-"));
    tempDirs.push(repoDir);
    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.email", "ci@example.invalid"]);
    git(repoDir, ["config", "user.name", "CI"]);
    writeRepoFile(repoDir, "src/old.ts", "export const value = 1;\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "base"]);
    const base = git(repoDir, ["rev-parse", "HEAD"]);
    fs.renameSync(path.join(repoDir, "src/old.ts"), path.join(repoDir, "src/new.ts"));
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "rename"]);

    expect(listChangedPaths(base, "HEAD", repoDir)).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("drops oversized changed-path payloads before workflow environment interpolation", () => {
    const outputPath = path.join(os.tmpdir(), `openclaw-ci-scope-output-${Date.now()}.txt`);
    markerPaths.push(outputPath);
    const changedPaths = Array.from(
      { length: 1_000 },
      (_, index) => `src/generated/${index}-${"x".repeat(100)}.ts`,
    );
    writeGitHubOutput(
      detectChangedScope(["docs/ci.md"]),
      outputPath,
      undefined,
      undefined,
      false,
      changedPaths,
    );

    expect(parseGitHubOutput(fs.readFileSync(outputPath, "utf8")).changed_paths_json).toBe("null");
  });

  it("loads from a zero-install tree and keeps empty diffs as no-op scope", () => {
    const repoDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ci-scope-empty-")),
    );
    tempDirs.push(repoDir);
    const outputPath = path.join(repoDir, "github-output.txt");
    const scriptPath = path.join(repoDir, "scripts/ci-changed-scope.mjs");

    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "ci@example.invalid"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "CI"], { cwd: repoDir });
    for (const sourcePath of [
      "scripts/ci-changed-scope.mjs",
      "scripts/lib/changed-path-facts.mjs",
      "scripts/lib/direct-run.mjs",
      "scripts/lib/merge-head-diff-base.mjs",
    ]) {
      writeRepoFile(repoDir, sourcePath, fs.readFileSync(path.resolve(sourcePath), "utf8"));
    }
    fs.writeFileSync(path.join(repoDir, "README.md"), "test\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "test"], { cwd: repoDir });

    expect(fs.existsSync(path.join(repoDir, "node_modules"))).toBe(false);
    execFileSync(process.execPath, [scriptPath, "--base", "HEAD", "--head", "HEAD"], {
      cwd: repoDir,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });

    const output = parseGitHubOutput(fs.readFileSync(outputPath, "utf8"));
    expect(Object.keys(output).toSorted()).toEqual(
      "changed_paths_json run_android run_changed_smoke run_control_ui_i18n run_fast_install_smoke run_full_install_smoke run_ios_build run_macos run_native_i18n run_node run_node_fast_ci_routing run_node_fast_only run_node_fast_plugin_contracts run_skills_python run_ui_tests run_windows strict_control_ui_i18n strict_native_i18n".split(
        " ",
      ),
    );
    expect(output.changed_paths_json).toBe("[]");
    for (const [key, value] of Object.entries(output)) {
      if (key !== "changed_paths_json") {
        expect(value, key).toBe("false");
      }
    }
  });
});
