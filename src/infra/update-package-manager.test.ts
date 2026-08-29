// Covers package manager resolution for update build flows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveUpdateBuildManager } from "./update-package-manager.js";

type PackageManagerCommandRunner = Parameters<typeof resolveUpdateBuildManager>[0];
const roots: string[] = [];
function pnpmRootEnvironment(root: string) {
  return {
    NPM_CONFIG_WORKSPACE_DIR: root,
    npm_config_workspace_dir: root,
    PNPM_CONFIG_LOCKFILE_DIR: root,
    pnpm_config_lockfile_dir: root,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function checkout(version: string) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-manager-test-")),
  );
  roots.push(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: `pnpm@${version}+sha512.test` }),
  );
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return root;
}

describe("resolveUpdateBuildManager", () => {
  it.each(["require-preferred", "allow-fallback"] as const)(
    "returns a structured result when the probe workspace cannot be allocated (%s)",
    async (requirement) => {
      const root = await checkout("12.0.0");
      vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(
        Object.assign(new Error("temporary storage unavailable"), { code: "EACCES" }),
      );
      const runCommand = vi.fn(async () => ({ stdout: "12.0.0", stderr: "", code: 0 }));
      const result = await resolveUpdateBuildManager(runCommand, root, 5000, {}, requirement);
      expect(result).toEqual(
        requirement === "require-preferred"
          ? { kind: "missing-required", preferred: "pnpm", reason: "preferred-manager-unavailable" }
          : { kind: "resolved", manager: "npm", preferred: "pnpm", fallback: true, env: {} },
      );
      expect(runCommand.mock.calls).toEqual(
        requirement === "require-preferred"
          ? []
          : [[["npm", "--version"], { timeoutMs: 5000, cwd: root, env: {} }]],
      );
    },
  );

  it.each([
    { version: "12.0.0", hostVersion: "11.15.1", pathKey: "PATH", rootOverrides: [] },
    {
      version: "11.22.0",
      hostVersion: "12.0.0",
      pathKey: "Path",
      rootOverrides: ["npm_config_workspace_dir"],
    },
    {
      version: "12.0.0",
      hostVersion: undefined,
      pathKey: "PATH",
      // Hostile fixture proves context replacement, not live host override permission.
      // nosemgrep: security.opengrep.ghsa-j425-whc4-4jgc.openclaw-dangerous-host-env-override-pivots
      rootOverrides: ["NPM_CONFIG_WORKSPACE_DIR"],
    },
    {
      version: "12.0.0",
      hostVersion: "11.15.1",
      pathKey: "PATH",
      // Hostile fixture proves context replacement, not live host override permission.
      // nosemgrep: security.opengrep.ghsa-j425-whc4-4jgc.openclaw-dangerous-host-env-override-pivots
      rootOverrides: ["NPM_CONFIG_WORKSPACE_DIR"],
    },
    {
      version: "11.22.0",
      hostVersion: "12.0.0",
      pathKey: "PATH",
      rootOverrides: ["PNPM_CONFIG_LOCKFILE_DIR"],
    },
    {
      version: "11.22.0",
      hostVersion: "12.0.0",
      pathKey: "Path",
      rootOverrides: ["pnpm_config_lockfile_dir"],
    },
    {
      version: "12.0.0",
      hostVersion: "11.15.1",
      pathKey: "PATH",
      rootOverrides: [
        // Hostile fixture proves context replacement, not live host override permission.
        // nosemgrep: security.opengrep.ghsa-j425-whc4-4jgc.openclaw-dangerous-host-env-override-pivots
        "NPM_CONFIG_WORKSPACE_DIR",
        "npm_config_workspace_dir",
        "PNPM_CONFIG_LOCKFILE_DIR",
        "pnpm_config_lockfile_dir",
      ],
    },
  ])(
    "bootstraps exact pnpm $version from $hostVersion with root overrides $rootOverrides",
    async ({ version, hostVersion, pathKey, rootOverrides }) => {
      const root = await checkout(version);
      const inheritedRoot = rootOverrides.length > 0 ? await checkout("11.22.0") : root;
      // Put the probe below a pinned ancestor; cwd alone cannot isolate pnpm.
      vi.spyOn(os, "tmpdir").mockReturnValue(root);
      const lockPath = path.join(root, "pnpm-lock.yaml");
      const lockBefore = await fs.readFile(lockPath);
      const baseEnv = Object.freeze({
        [pathKey]: "/ambient/bin",
        UPDATE_TEST: "preserved",
        ...Object.fromEntries(rootOverrides.map((key) => [key, inheritedRoot])),
      });
      const calls: string[][] = [];
      let prefix = "";
      const runCommand: PackageManagerCommandRunner = async (argv, options) => {
        calls.push(argv);
        expect(options.timeoutMs).toBe(5000);
        expect(options.env?.UPDATE_TEST).toBe("preserved");
        const key = argv.join(" ");
        if (key === "pnpm --version") {
          // The real update runner merges the base back into every child env.
          const env = { ...baseEnv, ...options.env };
          const envPath = env.PATH ?? env.Path ?? "";
          const installed = Boolean(
            prefix &&
            envPath.split(path.delimiter)[0] === path.join(prefix, "node_modules", ".bin"),
          );
          if (!hostVersion && !installed) {
            throw new Error("spawn pnpm ENOENT");
          }
          // pnpm's manifest owner is lockfileDir ?? workspaceDir ?? cwd.
          const cwd =
            env.PNPM_CONFIG_LOCKFILE_DIR ??
            env.pnpm_config_lockfile_dir ??
            env.NPM_CONFIG_WORKSPACE_DIR ??
            env.npm_config_workspace_dir ??
            options.cwd ??
            root;
          const manifest = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
          const hasWorkspace = await fs.stat(path.join(cwd, "pnpm-workspace.yaml")).then(
            () => true,
            () => false,
          );
          if (manifest.packageManager || !hasWorkspace) {
            // An old launcher resolves/writes @pnpm/exe before switching and
            // reporting the requested version, so version equality is not proof.
            await fs.appendFile(lockPath, "packageManagerDependencies: ['@pnpm/exe']\n");
            return { stdout: version, stderr: "", code: 0 };
          }
          return { stdout: installed ? version : (hostVersion ?? ""), stderr: "", code: 0 };
        }
        if (key === "corepack --version") {
          if (!hostVersion) {
            return { stdout: "0.35.0", stderr: "", code: 0 };
          }
          throw new Error("spawn corepack ENOENT");
        }
        if (argv[0] === "corepack" && argv[1] === "enable") {
          throw new Error("Corepack shim creation failed");
        }
        if (key === "npm --version") {
          return { stdout: "10.0.0", stderr: "", code: 0 };
        }
        if (key.startsWith("npm install --prefix ")) {
          prefix = argv[3] ?? "";
          roots.push(prefix);
          expect(argv[4]).toBe(`pnpm@${version}`);
          expect(JSON.parse(await fs.readFile(path.join(prefix, "package.json"), "utf8"))).toEqual({
            private: true,
            allowScripts: { [`pnpm@${version}`]: true },
          });
          return { stdout: "added pnpm", stderr: "", code: 0 };
        }
        throw new Error(`Unexpected command ${key}`);
      };
      const result = await resolveUpdateBuildManager(
        runCommand,
        root,
        5000,
        baseEnv,
        "require-preferred",
      );
      expect(await fs.readFile(lockPath)).toEqual(lockBefore);
      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") {
        throw new Error(result.reason);
      }
      expect(result.manager).toBe("pnpm");
      expect(result.env).toEqual({
        ...baseEnv,
        ...pnpmRootEnvironment(root),
        [pathKey]: `${path.join(prefix, "node_modules", ".bin")}${path.delimiter}/ambient/bin`,
      });
      expect(calls).toContainEqual(["npm", "install", "--prefix", prefix, `pnpm@${version}`]);
      await expect(fs.stat(prefix)).resolves.toBeDefined();
      await result.cleanup?.();
      await expect(fs.stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(lockPath)).toEqual(lockBefore);
    },
  );

  it.each([
    { pin: "bun@1.2.0", available: "bun", preferred: "bun", fallback: false },
    { pin: "npm@12.0.2", available: "npm", preferred: "npm", fallback: false },
    { pin: undefined, available: "pnpm", preferred: "pnpm", fallback: false },
    { pin: "bun@1.2.0", available: "npm", preferred: "bun", fallback: true },
  ])(
    "preserves $preferred selection with $available available and pin $pin",
    async ({ pin, available, preferred, fallback }) => {
      const root = await checkout("12.0.0");
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: pin }));
      const calls: string[][] = [];
      const runCommand: PackageManagerCommandRunner = async (argv) => {
        calls.push(argv);
        return { stdout: "1.0.0", stderr: "", code: argv[0] === available ? 0 : 1 };
      };
      const baseEnv = { PATH: "/ambient/bin" };
      expect(await resolveUpdateBuildManager(runCommand, root, 5000, baseEnv)).toMatchObject({
        kind: "resolved",
        manager: available,
        preferred,
        fallback,
        ...(available === "pnpm" ? { env: { ...baseEnv, ...pnpmRootEnvironment(root) } } : {}),
      });
      expect(calls.every(([, command]) => command === "--version")).toBe(true);
    },
  );

  it("does not let a neutral pnpm probe mask a usable fallback for another manager", async () => {
    const root = await checkout("12.0.0");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "npm@12.0.2" }),
    );
    const runCommand: PackageManagerCommandRunner = async (argv, options) => {
      if (argv[0] === "npm") {
        return { stdout: "", stderr: "npm unavailable", code: 1 };
      }
      if (argv[0] === "bun") {
        return { stdout: "1.3.0", stderr: "", code: 0 };
      }
      if (argv[0] !== "pnpm") {
        throw new Error(`Unexpected command ${argv.join(" ")}`);
      }
      const env = options.env ?? {};
      const projectRoot =
        env.PNPM_CONFIG_LOCKFILE_DIR ??
        env.pnpm_config_lockfile_dir ??
        env.NPM_CONFIG_WORKSPACE_DIR ??
        env.npm_config_workspace_dir ??
        options.cwd ??
        root;
      const manifest = JSON.parse(
        await fs.readFile(path.join(projectRoot, "package.json"), "utf8"),
      );
      return manifest.packageManager?.startsWith("npm@")
        ? { stdout: "", stderr: "This project is configured to use npm", code: 1 }
        : { stdout: "12.0.0", stderr: "", code: 0 };
    };
    expect(await resolveUpdateBuildManager(runCommand, root, 5000, {})).toMatchObject({
      kind: "resolved",
      manager: "bun",
      preferred: "npm",
      fallback: true,
    });
  });

  it.each(["11.22.0", "12.0.0"])(
    "reuses a matching pnpm %s in the target checkout",
    async (version) => {
      const root = await checkout(version);
      const inheritedRoot = await checkout(version === "12.0.0" ? "11.22.0" : "12.0.0");
      const baseEnv = Object.freeze({
        PATH: "/ambient/bin",
        ...pnpmRootEnvironment(inheritedRoot),
      });
      let probeRoot = "";
      const calls: string[][] = [];
      const runCommand: PackageManagerCommandRunner = async (argv, options) => {
        calls.push(argv);
        probeRoot = options.cwd ?? "";
        return { stdout: version, stderr: "", code: 0 };
      };
      const result = await resolveUpdateBuildManager(runCommand, root, 5000, baseEnv);
      expect(result).toEqual({
        kind: "resolved",
        manager: "pnpm",
        preferred: "pnpm",
        fallback: false,
        env: { ...baseEnv, ...pnpmRootEnvironment(root) },
      });
      expect(calls).toEqual([["pnpm", "--version"]]);
      expect(probeRoot).not.toBe(root);
      await expect(fs.stat(probeRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(root)).resolves.toBeDefined();
    },
  );

  it.each([undefined, "11.15.1"])(
    "uses temporary Corepack shims with ambient pnpm %s and no npm",
    async (hostVersion) => {
      const root = await checkout("12.0.0");
      const lockBefore = await fs.readFile(path.join(root, "pnpm-lock.yaml"));
      const inheritedRoot = await checkout("11.22.0");
      const baseEnv = Object.freeze({
        PATH: "/ambient/bin",
        UPDATE_TEST: "preserved",
        ...pnpmRootEnvironment(inheritedRoot),
      });
      const calls: string[][] = [];
      let shimDir = "";
      const runCommand: PackageManagerCommandRunner = async (argv, options) => {
        calls.push(argv);
        const key = argv.join(" ");
        if (key === "corepack --version") {
          return { stdout: "0.35.0", stderr: "", code: 0 };
        }
        if (argv[0] === "corepack" && argv[1] === "enable") {
          if (argv[2] !== "--install-directory" || !argv[3] || argv[4] !== "pnpm") {
            return { stdout: "", stderr: "global toolchain is read-only", code: 1 };
          }
          shimDir = argv[3];
          roots.push(shimDir);
          await fs.access(shimDir);
          return { stdout: "", stderr: "", code: 0 };
        }
        if (argv[0] === "pnpm") {
          const selectedShim = shimDir && options.env?.PATH?.split(path.delimiter)[0] === shimDir;
          if (selectedShim) {
            expect(options.cwd).toBe(root);
            expect(options.env).toEqual({
              ...baseEnv,
              ...pnpmRootEnvironment(root),
              PATH: `${shimDir}${path.delimiter}/ambient/bin`,
            });
            return { stdout: "12.0.0", stderr: "", code: 0 };
          }
          if (!hostVersion) {
            throw new Error("spawn pnpm ENOENT");
          }
          if (options.cwd === root) {
            await fs.appendFile(path.join(root, "pnpm-lock.yaml"), "changed by ambient pnpm\n");
            return { stdout: "12.0.0", stderr: "", code: 0 };
          }
          return { stdout: hostVersion, stderr: "", code: 0 };
        }
        throw new Error(`Unavailable command ${key}`);
      };
      const result = await resolveUpdateBuildManager(
        runCommand,
        root,
        5000,
        baseEnv,
        "require-preferred",
      );
      expect(await fs.readFile(path.join(root, "pnpm-lock.yaml"))).toEqual(lockBefore);
      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") {
        throw new Error(result.reason);
      }
      expect(shimDir).not.toBe(root);
      expect(result.env?.PATH).toBe(`${shimDir}${path.delimiter}/ambient/bin`);
      await runCommand(["pnpm", "build"], { cwd: root, timeoutMs: 5000, env: result.env });
      expect(calls.some(([command]) => command === "npm")).toBe(false);
      expect(calls).not.toContainEqual(["corepack", "enable"]);
      await result.cleanup?.();
      await expect(fs.stat(shimDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(root, "pnpm-lock.yaml"))).toEqual(lockBefore);
    },
  );

  it.each(["install", "verify"])("cleans failed pnpm bootstrap at %s", async (failure) => {
    const root = await checkout("12.0.0");
    let prefix = "";
    const runCommand: PackageManagerCommandRunner = async (argv) => {
      const key = argv.join(" ");
      if (key === "pnpm --version" || key === "corepack --version") {
        throw new Error("missing tool");
      }
      if (key === "npm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
      }
      prefix = argv[3] ?? "";
      return { stdout: "", stderr: "", code: failure === "install" ? 1 : 0 };
    };
    const result = await resolveUpdateBuildManager(
      runCommand,
      root,
      5000,
      undefined,
      "require-preferred",
    );
    expect(result).toEqual({
      kind: "missing-required",
      preferred: "pnpm",
      reason: "pnpm-npm-bootstrap-failed",
    });
    await expect(fs.stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
