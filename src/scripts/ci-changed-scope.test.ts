import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledPluginFile } from "../../test/helpers/bundled-plugin-paths.js";

const { detectChangedScope, listChangedPaths } =
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
    listChangedPaths: (base: string, head?: string) => string[];
  };

const markerPaths: string[] = [];

afterEach(() => {
  for (const markerPath of markerPaths) {
    try {
      fs.unlinkSync(markerPath);
    } catch {}
  }
  markerPaths.length = 0;
});

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
    expect(detectChangedScope(["src/plugins/runtime/index.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
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

  it("runs platform lanes when the CI workflow changes", () => {
    expect(detectChangedScope([".github/workflows/ci.yml"])).toEqual({
      runNode: true,
      runMacos: true,
      runAndroid: true,
      runWindows: true,
      runSkillsPython: true,
      runChangedSmoke: false,
      runControlUiI18n: false,
    });
  });

  it("runs changed-smoke for install and packaging surfaces", () => {
    expect(detectChangedScope(["scripts/install.sh"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: true,
      runControlUiI18n: false,
    });
    expect(detectChangedScope([bundledPluginFile("matrix", "package.json")])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
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
  });

  it("runs control-ui locale check only for control-ui i18n surfaces", () => {
    expect(detectChangedScope(["ui/src/i18n/locales/en.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: true,
    });

    expect(detectChangedScope(["scripts/control-ui-i18n.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runChangedSmoke: false,
      runControlUiI18n: true,
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
});
