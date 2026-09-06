import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolvePluginNpmProjectDir } from "./install-paths.js";
import { applyPluginUninstallDirectoryRemoval } from "./uninstall.js";

vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: vi.fn() }));
vi.mock("../infra/npm-managed-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/npm-managed-root.js")>()),
  readOpenClawManagedNpmRootOverrides: async () => ({}),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const command = vi.mocked(runCommandWithTimeout);
const commandResult = {
  code: 0,
  stdout: "",
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit",
} as const;

async function writePackage(dir: string, manifest: Record<string, unknown>) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function revokeAtBoundary() {
  const entered = createDeferred();
  const resume = createDeferred();
  const failure = new Error("delegated uninstall authority closed");
  let open = true;
  let denials = 0;
  return {
    failure,
    entered: entered.promise,
    async pause() {
      entered.resolve();
      await resume.promise;
    },
    beforePersistentApply: () => {
      if (!open) {
        denials += 1;
        throw failure;
      }
    },
    revoke() {
      open = false;
      resume.resolve();
    },
    release: () => resume.resolve(),
    denials: () => denials,
  };
}

async function expectRevokedRemoval(
  pending: ReturnType<typeof applyPluginUninstallDirectoryRemoval>,
  boundary: ReturnType<typeof revokeAtBoundary>,
) {
  try {
    expect(
      await Promise.race([
        boundary.entered.then(() => "paused"),
        pending.then(
          () => "completed",
          () => "rejected",
        ),
      ]),
    ).toBe("paused");
    boundary.revoke();
    await expect(pending).rejects.toBe(boundary.failure);
    expect(boundary.denials()).toBe(1);
  } finally {
    boundary.release();
    await pending.catch(() => undefined);
  }
}

describe("plugin uninstall directory removal", () => {
  beforeEach(() => {
    command.mockReset().mockResolvedValue(commandResult);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes a dangling managed-target symlink", async () => {
    const root = tempDirs.make("openclaw-plugin-uninstall-");
    const target = path.join(root, "plugin");
    await fs.symlink(path.join(root, "missing-target"), target, "dir");

    await expect(fs.lstat(target)).resolves.toBeDefined();
    await expect(applyPluginUninstallDirectoryRemoval({ target })).resolves.toEqual({
      directoryRemoved: true,
      warnings: [],
    });
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["isolated-project", "legacy-shared"] as const)(
    "revalidates uninstall authority after the %s manifest probe",
    async (rootKind) => {
      const root = tempDirs.make("openclaw-plugin-uninstall-authority-");
      const packageName = "removed-plugin";
      const npmRoot =
        rootKind === "isolated-project"
          ? resolvePluginNpmProjectDir({ packageName, npmDir: path.join(root, "npm") })
          : path.join(root, "npm");
      const target = path.join(npmRoot, "node_modules", packageName);
      await writePackage(npmRoot, { private: true, dependencies: { [packageName]: "1.0.0" } });
      await writePackage(target, { name: packageName });
      const manifestPath = path.join(npmRoot, "package.json");
      const manifest = await fs.readFile(manifestPath, "utf8");
      const boundary = revokeAtBoundary();
      const access = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation(async (...args) => {
        await access(...args);
        if (args[0] === manifestPath) {
          await boundary.pause();
        }
      });
      const remove = vi.spyOn(fs, "rm");

      await expectRevokedRemoval(
        applyPluginUninstallDirectoryRemoval(
          {
            target,
            cleanup: { kind: "npm", npmRoot, packageName, rootKind },
          },
          boundary.beforePersistentApply,
        ),
        boundary,
      );

      expect(command).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      await expect(fs.readFile(manifestPath, "utf8")).resolves.toBe(manifest);
      await expect(fs.readFile(path.join(target, "package.json"), "utf8")).resolves.toContain(
        packageName,
      );
    },
  );

  it.each(["npm-uninstall", "npm-peer-plan", "peer-directory", "peer-link"] as const)(
    "preserves authority failure after legacy cleanup awaits %s",
    async (phase) => {
      const root = tempDirs.make("openclaw-plugin-uninstall-authority-");
      const npmRoot = path.join(root, "npm");
      const packageName = "removed-plugin";
      const target = path.join(npmRoot, "node_modules", packageName);
      const peerDir = path.join(npmRoot, "node_modules", "peer-plugin");
      const peerNodeModules = path.join(peerDir, "node_modules");
      const peerLink = path.join(peerNodeModules, "openclaw");
      const oldHost = path.join(root, "old-host");
      await writePackage(npmRoot, {
        private: true,
        dependencies: { [packageName]: "1.0.0", "runtime-peer": "1.0.0", "peer-plugin": "1.0.0" },
        openclaw: { managedPeerDependencies: ["runtime-peer"] },
      });
      await writePackage(target, { name: packageName });
      await writePackage(peerDir, { name: "peer-plugin", peerDependencies: { openclaw: "*" } });
      await writePackage(oldHost, { name: "openclaw" });
      if (phase !== "peer-directory") {
        await fs.mkdir(peerNodeModules, { recursive: true });
        await fs.symlink(oldHost, peerLink, "junction");
      }
      const manifestPath = path.join(npmRoot, "package.json");
      const manifest = await fs.readFile(manifestPath, "utf8");
      const boundary = revokeAtBoundary();
      command.mockImplementation(async (argv, options) => {
        if (argv[1] === "uninstall" && phase === "npm-uninstall") {
          await boundary.pause();
        } else if (argv.includes("--package-lock-only")) {
          if (typeof options === "number" || !options.cwd) {
            throw new Error("npm peer planning requires its isolated working directory");
          }
          await fs.writeFile(
            path.join(options.cwd, "package-lock.json"),
            JSON.stringify({
              lockfileVersion: 3,
              packages: { "": {} },
            }),
          );
          if (phase === "npm-peer-plan") {
            await boundary.pause();
          }
        }
        return commandResult;
      });
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        try {
          return await lstat(...args);
        } finally {
          if (
            (phase === "peer-directory" && args[0] === peerNodeModules) ||
            (phase === "peer-link" && args[0] === peerLink)
          ) {
            await boundary.pause();
          }
        }
      });

      await expectRevokedRemoval(
        applyPluginUninstallDirectoryRemoval(
          {
            target,
            cleanup: { kind: "npm", npmRoot, packageName, rootKind: "legacy-shared" },
          },
          boundary.beforePersistentApply,
        ),
        boundary,
      );

      expect(command).toHaveBeenCalledTimes(
        phase === "npm-uninstall" ? 1 : phase === "npm-peer-plan" ? 2 : 3,
      );
      await expect(fs.readFile(path.join(target, "package.json"), "utf8")).resolves.toContain(
        packageName,
      );
      if (phase === "npm-uninstall" || phase === "npm-peer-plan") {
        await expect(fs.readFile(manifestPath, "utf8")).resolves.toBe(manifest);
      }
      if (phase === "peer-directory") {
        await expect(lstat(peerNodeModules)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(fs.readlink(peerLink)).resolves.toBe(oldHost);
      }
    },
  );

  it("revalidates uninstall authority before deleting an empty git install parent", async () => {
    const parentDir = tempDirs.make("openclaw-plugin-uninstall-authority-");
    const target = path.join(parentDir, "checkout");
    await writePackage(target, { name: "removed-plugin" });
    const boundary = revokeAtBoundary();
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      await remove(...args);
      if (args[0] === target) {
        await boundary.pause();
      }
    });
    const removeParent = vi.spyOn(fs, "rmdir");

    await expectRevokedRemoval(
      applyPluginUninstallDirectoryRemoval(
        {
          target,
          cleanup: { kind: "git", parentDir },
        },
        boundary.beforePersistentApply,
      ),
      boundary,
    );

    expect(removeParent).not.toHaveBeenCalled();
    await expect(fs.readdir(parentDir)).resolves.toEqual([]);
  });
});
