// Codex tests cover managed binary plugin behavior.
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
} from "./managed-binary.js";

function startOptions(
  commandSource: CodexAppServerStartOptions["commandSource"],
  managedCommandOrder?: CodexAppServerStartOptions["managedCommandOrder"],
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    commandSource,
    ...(managedCommandOrder ? { managedCommandOrder } : {}),
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

function managedCommandPath(root: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(root, "node_modules", ".bin", platform === "win32" ? "codex.cmd" : "codex");
}

const MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND = "/Applications/Codex.app/Contents/Resources/codex";
const MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND =
  "/Applications/ChatGPT.app/Contents/Resources/codex";

describe("managed Codex app-server binary", () => {
  it("resolves the platform-native artifact behind the managed npm launcher", () => {
    const packageJsonPath =
      "/repo/extensions/codex/node_modules/@openai/codex-darwin-arm64/package.json";
    const expected =
      "/repo/extensions/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";

    expect(
      resolveManagedCodexNativeCommand("/repo/extensions/codex/node_modules/.bin/codex", {
        platform: "darwin",
        arch: "arm64",
        resolvePackageJson: (packageName, root) =>
          packageName === "@openai/codex-darwin-arm64" &&
          root === "/repo/extensions/codex/node_modules/@openai/codex"
            ? packageJsonPath
            : undefined,
        pathExists: (candidate) => candidate === expected,
      }),
    ).toBe(expected);
  });

  it("reports the desktop bundle binary as its native artifact", () => {
    expect(
      resolveManagedCodexNativeCommand(MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND, {
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe(MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND);
  });

  it("leaves explicit command overrides unchanged", async () => {
    const explicitOptions = startOptions("config");
    const pathExists = vi.fn(async () => false);

    await expect(
      resolveManagedCodexAppServerStartOptions(explicitOptions, {
        platform: "darwin",
        pathExists,
      }),
    ).resolves.toBe(explicitOptions);
    expect(pathExists).not.toHaveBeenCalled();
  });

  it("keeps the pinned package ahead of stale desktop bundles for ordinary turns", async () => {
    const pluginRoot = path.join("/tmp", "openclaw", "extensions", "codex");
    const pluginLocalCommand = managedCommandPath(pluginRoot, "darwin");
    const pathExists = vi.fn(
      async (filePath: string) =>
        filePath === MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND ||
        filePath === MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND ||
        filePath === pluginLocalCommand,
    );

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "darwin",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: pluginLocalCommand,
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: [
        MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND,
        MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND,
      ],
    });
  });

  it("prefers the ChatGPT.app desktop bundle for Computer Use", async () => {
    const pluginRoot = path.join("/tmp", "openclaw", "extensions", "codex");
    const pluginLocalCommand = managedCommandPath(pluginRoot, "darwin");
    const pathExists = vi.fn(
      async (filePath: string) =>
        filePath === MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND || filePath === pluginLocalCommand,
    );

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed", "desktop-first"), {
        platform: "darwin",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed", "desktop-first"),
      command: MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND,
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: [pluginLocalCommand],
    });
  });

  it("falls back to the legacy Codex.app desktop bundle when ChatGPT.app is absent", async () => {
    const pluginRoot = path.join("/tmp", "openclaw", "extensions", "codex");
    const pluginLocalCommand = managedCommandPath(pluginRoot, "darwin");
    const pathExists = vi.fn(
      async (filePath: string) =>
        filePath === MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND || filePath === pluginLocalCommand,
    );

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed", "desktop-first"), {
        platform: "darwin",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed", "desktop-first"),
      command: MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND,
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: [pluginLocalCommand],
    });
  });

  it("falls back to the plugin-local binary when neither desktop bundle exists", async () => {
    const pluginRoot = path.join("/tmp", "openclaw", "extensions", "codex");
    const pluginLocalCommand = managedCommandPath(pluginRoot, "darwin");
    const pathExists = vi.fn(async (filePath: string) => filePath === pluginLocalCommand);

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed", "desktop-first"), {
        platform: "darwin",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed", "desktop-first"),
      command: pluginLocalCommand,
      commandSource: "resolved-managed",
    });
    expect(pathExists).toHaveBeenCalledWith(MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND, "darwin");
    expect(pathExists).toHaveBeenCalledWith(MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND, "darwin");
  });

  it("finds Codex in the package install root used by packaged plugins", async () => {
    const installRoot = path.join("/tmp", "openclaw-plugin-package", "codex");
    const pluginRoot = path.join(installRoot, "dist", "extensions", "codex");
    const installedCommand = managedCommandPath(installRoot, "linux");
    const pathExists = vi.fn(async (filePath: string) => filePath === installedCommand);

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: installedCommand,
      commandSource: "resolved-managed",
    });
  });

  it("finds Codex bins hoisted into an isolated npm project root", async () => {
    const projectRoot = path.join("/tmp", "state", "npm", "projects", "openclaw-codex-hash");
    const pluginRoot = path.join(projectRoot, "node_modules", "@openclaw", "codex");
    const installedCommand = managedCommandPath(projectRoot, "linux");
    const pathExists = vi.fn(async (filePath: string) => filePath === installedCommand);

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: installedCommand,
      commandSource: "resolved-managed",
    });
  });

  it("finds Windows Codex shims hoisted into an isolated npm project root", async () => {
    const projectRoot = path.win32.join(
      "C:\\",
      "Users",
      "test",
      ".openclaw",
      "npm",
      "projects",
      "openclaw-codex-hash",
    );
    const pluginRoot = path.win32.join(projectRoot, "node_modules", "@openclaw", "codex");
    const installedCommand = managedCommandPath(projectRoot, "win32");
    const pathExists = vi.fn(async (filePath: string) => filePath === installedCommand);

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "win32",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: installedCommand,
      commandSource: "resolved-managed",
    });
  });

  it("falls back to the resolved Codex package bin when no command shim exists", async () => {
    const installRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-package-"));
    const pluginRoot = path.join(installRoot, "dist", "extensions", "codex");
    const packageRoot = path.join(installRoot, "node_modules", "@openai", "codex");
    const packageBin = path.join(packageRoot, "bin", "codex.js");
    await mkdir(path.dirname(packageBin), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@openai/codex",
        bin: {
          codex: "bin/codex.js",
        },
      }),
    );
    await writeFile(packageBin, "#!/usr/bin/env node\n");
    const resolvedPackageBin = await realpath(packageBin);

    const pathExists = vi.fn(async (filePath: string) => filePath === resolvedPackageBin);

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: resolvedPackageBin,
      commandSource: "resolved-managed",
    });
  });

  it("fails clearly when the managed Codex binary is missing", async () => {
    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "darwin",
        pluginRoot: path.join("/tmp", "openclaw", "extensions", "codex"),
        pathExists: vi.fn(async () => false),
      }),
    ).rejects.toThrow("Managed Codex app-server binary was not found");
  });
});
