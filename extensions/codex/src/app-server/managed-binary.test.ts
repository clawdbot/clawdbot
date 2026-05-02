import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  resolveManagedCodexAppServerPaths,
  resolveManagedCodexAppServerStartOptions,
} from "./managed-binary.js";

function startOptions(
  commandSource: CodexAppServerStartOptions["commandSource"],
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    commandSource,
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

function managedCommandPath(root: string, platform: NodeJS.Platform): string {
  return path.join(root, "node_modules", ".bin", platform === "win32" ? "codex.cmd" : "codex");
}

describe("managed Codex app-server binary", () => {
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

  it("resolves the plugin-local bundled Codex binary", async () => {
    const pluginRoot = path.join("/tmp", "openclaw", "extensions", "codex");
    const paths = resolveManagedCodexAppServerPaths({ platform: "darwin", pluginRoot });
    const pathExists = vi.fn(async (filePath: string) => filePath === paths.commandPath);

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "darwin",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: paths.commandPath,
      commandSource: "resolved-managed",
    });
    expect(paths.commandPath).toBe(managedCommandPath(pluginRoot, "darwin"));
  });

  it("resolves Windows Codex command shims", () => {
    const pluginRoot = path.win32.join("C:\\", "OpenClaw", "dist", "extensions", "codex");
    const paths = resolveManagedCodexAppServerPaths({ platform: "win32", pluginRoot });

    expect(paths.commandPath.endsWith(path.win32.join("node_modules", ".bin", "codex.cmd"))).toBe(
      true,
    );
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
