// Codex tests cover managed binary plugin behavior.
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginInstance } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import {
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
  setManagedCodexPluginRoot,
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
  return path.join(root, "node_modules", ".bin", platform === "win32" ? "codex.cmd" : "codex");
}

async function writeExecutable(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/usr/bin/env node\n");
  await chmod(file, 0o755);
}

async function writePackageLauncher(owner: string): Promise<string> {
  const packageRoot = path.join(owner, "node_modules", "@openai", "codex");
  const launcher = path.join(packageRoot, "bin", "codex.js");
  await writeExecutable(launcher);
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      type: "module",
      bin: { codex: "bin/codex.js" },
    }),
  );
  return launcher;
}

const MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND = "/Applications/Codex.app/Contents/Resources/codex";
const MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND =
  "/Applications/ChatGPT.app/Contents/Resources/codex";

describe("managed Codex app-server binary", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-owner-")));
  });
  afterEach(async () => {
    setManagedCodexPluginRoot(undefined);
    await rm(root, { recursive: true, force: true });
  });

  it("resolves the platform-native artifact behind the managed npm launcher", () => {
    const packageJsonPath =
      "/repo/extensions/codex/node_modules/@openai/codex-darwin-arm64/package.json";
    const expected =
      "/repo/extensions/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";

    expect(
      resolveManagedCodexNativeCommand("/repo/extensions/codex/node_modules/.bin/codex", {
        platform: "darwin",
        arch: "arm64",
        resolvePackageJson: (packageName, packageRoot) =>
          packageName === "@openai/codex-darwin-arm64" &&
          packageRoot === "/repo/extensions/codex/node_modules/@openai/codex"
            ? packageJsonPath
            : undefined,
        pathExists: (candidate) => candidate === expected,
      }),
    ).toBe(expected);
  });

  it("resolves native dependencies from the real package behind an isolated install shim", async () => {
    const installRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-isolated-")),
    );
    try {
      const platform = process.platform === "win32" ? "win32" : "linux";
      const modulesDir = path.join(installRoot, "node_modules");
      const realScopeDir = path.join(modulesDir, ".pnpm", "codex-slot", "node_modules", "@openai");
      const packageRoot = path.join(realScopeDir, "codex");
      const platformPackage = `@openai/codex-${platform}-x64`;
      const platformRoot = path.join(realScopeDir, `codex-${platform}-x64`);
      const native = path.join(
        platformRoot,
        "vendor",
        platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-musl",
        "bin",
        platform === "win32" ? "codex.exe" : "codex",
      );
      const command = managedCommandPath(installRoot, platform);
      await mkdir(packageRoot, { recursive: true });
      await mkdir(path.dirname(native), { recursive: true });
      await mkdir(path.dirname(command), { recursive: true });
      await mkdir(path.join(modulesDir, "@openai"), { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@openai/codex" }),
      );
      await writeFile(
        path.join(platformRoot, "package.json"),
        JSON.stringify({ name: platformPackage }),
      );
      await writeFile(native, "native artifact fixture");
      await writeFile(command, "launcher fixture");
      await symlink(
        packageRoot,
        path.join(modulesDir, "@openai", "codex"),
        platform === "win32" ? "junction" : "dir",
      );

      expect(resolveManagedCodexNativeCommand(command, { platform, arch: "x64" })).toBe(native);
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });

  it("reports the desktop bundle binary as its native artifact", () => {
    expect(
      resolveManagedCodexNativeCommand(MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND, {
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe(MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND);
  });

  it.each([true, false])(
    "uses embedded vendor binaries only when the platform package is absent (present=%s)",
    (platformPackagePresent) => {
      const packageRoot = "/repo/node_modules/@openai/codex";
      const embedded = `${packageRoot}/vendor/aarch64-apple-darwin/bin/codex`;
      expect(
        resolveManagedCodexNativeCommand(`${packageRoot}/bin/codex.js`, {
          platform: "darwin",
          arch: "arm64",
          resolvePackageJson: (name) =>
            name === "@openai/codex"
              ? `${packageRoot}/package.json`
              : platformPackagePresent
                ? "/repo/node_modules/@openai/codex-darwin-arm64/package.json"
                : undefined,
          pathExists: (candidate) => candidate === embedded,
        }),
      ).toBe(platformPackagePresent ? undefined : embedded);
    },
  );

  it.each(["source", "bundled"])(
    "selects the owner-local package ahead of a stale ancestor shim (%s)",
    async (layout) => {
      const installRoot = path.join(root, "node_modules", "openclaw");
      const pluginRoot =
        layout === "source"
          ? path.join(installRoot, "extensions", "codex")
          : path.join(installRoot, "dist", "extensions", "codex");
      const launcher = await writePackageLauncher(pluginRoot);
      await writeExecutable(managedCommandPath(installRoot, "linux"));
      await writePackageLauncher(installRoot);
      setManagedCodexPluginRoot(pluginRoot);

      await expect(
        resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
          platform: "linux",
        }),
      ).resolves.toEqual({
        ...startOptions("managed"),
        command: launcher,
        commandSource: "resolved-managed",
      });
    },
  );

  it.each(["linux", "win32"] as const)(
    "resolves the isolated npm generation package without a local shim (%s)",
    async (platform) => {
      const generation = path.join(
        root,
        "npm",
        "projects",
        "openclaw-codex-fixture--g-0123456789abcdef",
      );
      const pluginRoot = path.join(generation, "node_modules", "@openclaw", "codex");
      await mkdir(pluginRoot, { recursive: true });
      const launcher = await writePackageLauncher(generation);
      // The flat project and an ancestor shim do not own this plugin's dependency.
      await writePackageLauncher(path.join(root, "npm", "projects", "openclaw-codex-fixture"));
      await writeExecutable(managedCommandPath(root, platform));

      await expect(
        resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
          platform,
          pluginRoot,
        }),
      ).resolves.toEqual({
        ...startOptions("managed"),
        command: launcher,
        commandSource: "resolved-managed",
      });
    },
  );

  it("resolves dependencies above a compiled plugin entry without reconstructing roots", async () => {
    const pluginRoot = path.join(root, "dist", "extensions", "codex");
    await mkdir(pluginRoot, { recursive: true });
    const launcher = await writePackageLauncher(root);
    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
        pluginRoot,
      }),
    ).resolves.toMatchObject({ command: launcher, commandSource: "resolved-managed" });
  });

  it("resolves the pnpm-linked owner dependency ahead of an ancestor shim", async () => {
    const pluginRoot = path.join(root, "extensions", "codex");
    const storeRoot = path.join(root, "node_modules", ".pnpm", "codex-slot");
    const launcher = await writePackageLauncher(storeRoot);
    const scope = path.join(pluginRoot, "node_modules", "@openai");
    await mkdir(scope, { recursive: true });
    await symlink(
      path.dirname(path.dirname(launcher)),
      path.join(scope, "codex"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeExecutable(managedCommandPath(root, "linux"));

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
        pluginRoot,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: launcher,
      commandSource: "resolved-managed",
    });
  });

  it("shares the registered owner with separately loaded runtime modules", async () => {
    const launcher = await writePackageLauncher(root);
    setManagedCodexPluginRoot(root);
    vi.resetModules();
    const runtimeCopy = await import("./managed-binary.js");
    await expect(
      runtimeCopy.resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
      }),
    ).resolves.toMatchObject({ command: launcher });
  });

  it("keeps the active launcher while a different-root candidate is prepared and discarded", async () => {
    const activeRoot = path.join(root, "active");
    const candidateRoot = path.join(root, "candidate");
    const activeLauncher = await writePackageLauncher(activeRoot);
    const candidateLauncher = await writePackageLauncher(candidateRoot);
    const active = new PluginInstance("codex");
    const candidate = new PluginInstance("codex");
    vi.resetModules();
    const runtimeCopy = await import("./managed-binary.js");
    const resolve = async () => {
      await Promise.resolve();
      return runtimeCopy.resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
      });
    };
    const resolveActive = active.wrap(resolve);
    const resolveCandidate = candidate.wrap(resolve);
    try {
      active.run(() => setManagedCodexPluginRoot(activeRoot));
      await expect(resolveActive()).resolves.toMatchObject({ command: activeLauncher });
      candidate.run(() => setManagedCodexPluginRoot(candidateRoot));
      await expect(resolveCandidate()).resolves.toMatchObject({ command: candidateLauncher });
      await expect(resolveActive()).resolves.toMatchObject({ command: activeLauncher });
      await candidate.dispose();
      await expect(resolveActive()).resolves.toMatchObject({ command: activeLauncher });
      expect(() => resolveCandidate()).toThrow("reloaded or disabled");
    } finally {
      await candidate.dispose();
      await active.dispose();
    }
  });

  it.each(["config", "env"] as const)(
    "preserves the %s override without managed discovery",
    async (source) => {
      const explicit = resolveCodexAppServerRuntimeOptions({
        pluginConfig:
          source === "config" ? { appServer: { command: "/operator/config-codex" } } : {},
        env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/operator/env-codex" },
        codexConfigToml: null,
        requirementsToml: null,
      }).start;
      const pathExists = vi.fn(async () => false);
      expect(explicit.commandSource).toBe(source);
      expect(explicit.command).toBe(`/operator/${source}-codex`);
      await expect(
        resolveManagedCodexAppServerStartOptions(explicit, {
          pathExists,
        }),
      ).resolves.toBe(explicit);
      expect(pathExists).not.toHaveBeenCalled();
    },
  );

  it.each([
    { order: "package-first", desktop: "both" },
    { order: "desktop-first", desktop: "both" },
    { order: "desktop-first", desktop: "legacy" },
    { order: "desktop-first", desktop: "none" },
  ] as const)(
    "honors macOS $order ordering with $desktop desktop bundles",
    async ({ order, desktop }) => {
      const launcher = await writePackageLauncher(root);
      const desktopCommands =
        desktop === "both"
          ? [MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND, MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND]
          : desktop === "legacy"
            ? [MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND]
            : [];
      const commands =
        order === "package-first" ? [launcher, ...desktopCommands] : [...desktopCommands, launcher];
      await expect(
        resolveManagedCodexAppServerStartOptions(startOptions("managed", order), {
          platform: "darwin",
          pluginRoot: root,
          pathExists: async (candidate) =>
            candidate.startsWith("/Applications/")
              ? desktopCommands.includes(candidate)
              : access(candidate).then(
                  () => true,
                  () => false,
                ),
        }),
      ).resolves.toEqual({
        ...startOptions("managed", order),
        command: commands[0],
        commandSource: "resolved-managed",
        ...(commands.length > 1 ? { managedFallbackCommandPaths: commands.slice(1) } : {}),
      });
    },
  );

  it("fails clearly when the managed package is absent even with an ancestor shim", async () => {
    const pluginRoot = path.join(root, "extensions", "codex");
    await mkdir(pluginRoot, { recursive: true });
    await writeExecutable(managedCommandPath(root, "linux"));
    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
        pluginRoot,
      }),
    ).rejects.toThrow("Managed Codex app-server binary was not found");
  });

  it("requires a loader-registered owner instead of guessing from the runtime module", async () => {
    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
      }),
    ).rejects.toThrow("Codex plugin root is unavailable");
  });
});
