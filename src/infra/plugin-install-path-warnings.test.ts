import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { repoInstallSpec } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "./plugin-install-path-warnings.js";

async function detectMatrixCustomPathIssue(sourcePath: string | ((pluginPath: string) => string)) {
  return withTempHome(async (home) => {
    const pluginPath = path.join(home, "matrix-plugin");
    await fs.mkdir(pluginPath, { recursive: true });
    const resolvedSourcePath =
      typeof sourcePath === "function" ? sourcePath(pluginPath) : sourcePath;
    const issue = await detectPluginInstallPathIssue({
      pluginId: "matrix",
      install: {
        source: "path",
        sourcePath: resolvedSourcePath,
        installPath: pluginPath,
      },
    });

    return { issue, pluginPath };
  });
}

const MATRIX_REPO_INSTALL_COMMAND = `openclaw plugins install ${repoInstallSpec("matrix")}`;

describe("plugin install path warnings", () => {
  it("ignores non-path installs and blank path candidates", async () => {
    expect(
      await detectPluginInstallPathIssue({
        pluginId: "matrix",
        install: null,
      }),
    ).toBeNull();
    expect(
      await detectPluginInstallPathIssue({
        pluginId: "matrix",
        install: {
          source: "npm",
          sourcePath: " ",
          installPath: " ",
        },
      }),
    ).toBeNull();
  });

  it("detects stale custom plugin install paths", async () => {
    const issue = await detectPluginInstallPathIssue({
      pluginId: "matrix",
      install: {
        source: "path",
        sourcePath: "/tmp/openclaw-matrix-missing",
        installPath: "/tmp/openclaw-matrix-missing",
      },
    });

    expect(issue).toEqual({
      kind: "missing-path",
      pluginId: "matrix",
      path: "/tmp/openclaw-matrix-missing",
    });
    expect(
      formatPluginInstallPathIssue({
        issue: issue!,
        pluginLabel: "Matrix",
        defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
        repoInstallCommand: MATRIX_REPO_INSTALL_COMMAND,
      }),
    ).toEqual([
      "Matrix is installed from a custom path that no longer exists: /tmp/openclaw-matrix-missing",
      'Reinstall with "openclaw plugins install @openclaw/matrix".',
      `If you are running from a repo checkout, you can also use "${MATRIX_REPO_INSTALL_COMMAND}".`,
    ]);
  });

  it("uses the second candidate path when the first one is stale", async () => {
    const { issue, pluginPath } = await detectMatrixCustomPathIssue("/tmp/openclaw-matrix-missing");
    expect(issue).toEqual({
      kind: "custom-path",
      pluginId: "matrix",
      path: pluginPath,
    });
  });

  it("detects active custom plugin install paths", async () => {
    const { issue, pluginPath } = await detectMatrixCustomPathIssue(
      (resolvedPluginPath) => resolvedPluginPath,
    );
    expect(issue).toEqual({
      kind: "custom-path",
      pluginId: "matrix",
      path: pluginPath,
    });
  });

  it("applies custom command formatting in warning messages", () => {
    expect(
      formatPluginInstallPathIssue({
        issue: {
          kind: "custom-path",
          pluginId: "matrix",
          path: "/tmp/matrix-plugin",
        },
        pluginLabel: "Matrix",
        defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
        repoInstallCommand: MATRIX_REPO_INSTALL_COMMAND,
        formatCommand: (command) => `<${command}>`,
      }),
    ).toEqual([
      "Matrix is installed from a custom path: /tmp/matrix-plugin",
      "Main updates will not automatically replace that plugin with the repo's default Matrix package.",
      'Reinstall with "<openclaw plugins install @openclaw/matrix>" when you want to return to the standard Matrix plugin.',
      `If you are intentionally running from a repo checkout, reinstall that checkout explicitly with "<${MATRIX_REPO_INSTALL_COMMAND}>" after updates.`,
    ]);
  });

  it("omits repo checkout guidance when no bundled source hint exists", () => {
    expect(
      formatPluginInstallPathIssue({
        issue: {
          kind: "missing-path",
          pluginId: "matrix",
          path: "/tmp/openclaw-matrix-missing",
        },
        pluginLabel: "Matrix",
        defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
        repoInstallCommand: null,
      }),
    ).toEqual([
      "Matrix is installed from a custom path that no longer exists: /tmp/openclaw-matrix-missing",
      'Reinstall with "openclaw plugins install @openclaw/matrix".',
    ]);
  });
});
