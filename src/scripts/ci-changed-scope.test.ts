import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";

const { detectChangedScope, detectInstallSmokeScope, detectNodeFastScope, listChangedPaths } =
  (await import("../../scripts/ci-changed-scope.mjs")) as unknown as {
    detectChangedScope: (paths: string[]) => {
      runNode: boolean;
      runMacos: boolean;
      runAndroid: boolean;
      runWindows: boolean;
      runSkillsPython: boolean;
      runChangedSmoke: boolean;
      runControlUiI18n: boolean;
    };
    detectInstallSmokeScope: (paths: string[]) => {
      runFastInstallSmoke: boolean;
      runFullInstallSmoke: boolean;
    };
    detectNodeFastScope: (paths: string[]) => {
      runFastOnly: boolean;
      runPluginContracts: boolean;
      runCiRouting: boolean;
    };
    listChangedPaths: (base: string, head?: string) => string[];
  };

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
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe("detectChangedScope", () => {
  it("fails safe when no paths are provided", () => {
    expect(detectChangedScope([])).toEqual({
      runNode: true,
      runMacos: true,
      runAndroid: true,
      runWindows: true,
      runSkillsPython: true,
      runChangedSmoke: true,
      runControlUiI18n: true,
    });
  });

  it("keeps all lanes off for docs-only changes", () => {
    expect(detectChangedScope(["docs/ci.md", "README.md"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
  });

  it("enables node lane for node-relevant files", () => {
    expect(detectChangedScope(["src/config/defaults.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
  });

  it("keeps node lane off for native-only changes", () => {
    expect(detectChangedScope(["apps/macos/Sources/Foo.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
    expect(
      detectChangedScope(["apps/macos-mlx-tts/Sources/OpenClawMLXTTSHelper/main.swift"]),
    ).toEqual({
      runNode: false,
      runMacos: true,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["apps/shared/OpenClawKit/Sources/Foo.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runAndroid: true,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
  });

  it("does not force macOS for generated protocol model-only changes", () => {
    expect(detectChangedScope(["apps/macos/Sources/OpenClawProtocol/GatewayModels.swift"])).toEqual(
      {
        runNode: false,
        runMacos: false,
        runAndroid: false,
        runWindows: false,
        runSkillsPython: false,
        runChangedSmoke: false,
        runControlUiI18n: false,
      },
    );
  });

  it("enables node lane for non-native non-doc files by fallback", () => {
    expect(detectChangedScope(["README.md"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });

    expect(detectChangedScope(["assets/icon.png"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
  });

  it("keeps windows lane off for non-runtime GitHub metadata files", () => {
    expect(detectChangedScope([".github/labeler.yml"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
  });

  it("runs Python skill tests when skills change", () => {
    expect(detectChangedScope(["skills/skill-creator/scripts/test_quick_validate.py"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: true,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
  });

  it("runs Python skill tests when shared Python config changes", () => {
    expect(detectChangedScope(["pyproject.toml"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: true,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
  });

  it("keeps native platform lanes scoped when the CI workflow changes", () => {
    expect(detectChangedScope([".github/workflows/ci.yml"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
  });

  it("runs Windows only for Windows-relevant changes", () => {
    expect(detectChangedScope(["extensions/memory-lancedb/index.test.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["src/auto-reply/reply/streaming-directives.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["src/process/exec.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["src/process/exec.windows.test.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["src/shared/runtime-import.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["src/shared/runtime-import.test.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["src/plugins/import-specifier.test.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["scripts/npm-runner.mjs"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
  });

  it("runs changed-smoke for install and packaging surfaces", () => {
    expect(detectChangedScope(["scripts/install.sh"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope([bundledPluginFile("matrix", "package.json")])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope([".github/workflows/install-smoke.yml"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["scripts/e2e/qr-import-docker.sh"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["scripts/e2e/gateway-network-docker.sh"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["scripts/e2e/Dockerfile"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["scripts/e2e/agents-delete-shared-workspace-docker.sh"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["scripts/e2e/plugin-update-unchanged-docker.sh"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["scripts/postinstall-bundled-plugins.mjs"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["scripts/ci-changed-scope.mjs"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
  });

  it("runs changed-smoke for Docker-covered core runtime surfaces", () => {
    expect(detectChangedScope(["src/plugins/loader.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["src/plugin-sdk/provider-entry.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["src/gateway/protocol/messages.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope(["src/channels/plugins/catalog.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope([bundledPluginFile("matrix", "index.ts")])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
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
    expect(detectInstallSmokeScope([bundledPluginFile("matrix", "index.ts")])).toEqual({
      runFastInstallSmoke: false,
      runFullInstallSmoke: false,
    });
  });

  it("keeps changed-smoke off for runtime-surface tests", () => {
    expect(detectChangedScope(["src/plugins/loader.test.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
    expect(detectChangedScope([bundledPluginFile("matrix", "index.test.ts")])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
  });

  it("runs control-ui locale check only for control-ui i18n surfaces", () => {
    expect(detectChangedScope(["ui/src/i18n/locales/en.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: true,
    });

    expect(detectChangedScope(["scripts/control-ui-i18n.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: true,
    });
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
        "scripts/test-projects.test-support.mjs",
        "test/scripts/test-projects.test.ts",
      ]),
    ).toEqual({
      runFastOnly: true,
      runPluginContracts: true,
      runCiRouting: false,
    });
  });

  it("identifies CI routing changes as fast Node-only CI scope", () => {
    expect(
      detectNodeFastScope([
        ".github/workflows/ci.yml",
        "scripts/ci-changed-scope.mjs",
        "src/commands/status.scan-result.test.ts",
        "src/scripts/ci-changed-scope.test.ts",
        "docs/ci.md",
      ]),
    ).toEqual({
      runFastOnly: true,
      runPluginContracts: false,
      runCiRouting: true,
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

    expect(() => listChangedPaths(injectedBase, "HEAD")).toThrow();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("keeps direct CLI preflight empty diffs as no-op scope", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ci-scope-empty-"));
    tempDirs.push(repoDir);
    const outputPath = path.join(repoDir, "github-output.txt");
    const scriptPath = path.resolve("scripts/ci-changed-scope.mjs");

    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "ci@example.invalid"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "CI"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "test\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "test"], { cwd: repoDir });

    execFileSync(process.execPath, [scriptPath, "--base", "HEAD", "--head", "HEAD"], {
      cwd: repoDir,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });

    expect(parseGitHubOutput(fs.readFileSync(outputPath, "utf8"))).toEqual({
      run_node: "false",
      run_macos: "false",
      run_android: "false",
      run_windows: "false",
      run_skills_python: "false",
      run_changed_smoke: "false",
      run_node_fast_only: "false",
      run_node_fast_plugin_contracts: "false",
      run_node_fast_ci_routing: "false",
      run_fast_install_smoke: "false",
      run_full_install_smoke: "false",
      run_control_ui_i18n: "false",
    });
  });
});
