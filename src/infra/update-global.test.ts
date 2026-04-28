import fs from "node:fs/promises";
import path from "node:path";
import { bundledDistPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../plugins/runtime-sidecar-paths.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import {
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  writePackageDistInventory,
} from "./package-dist-inventory.js";
import {
  canResolveRegistryVersionForPackageTarget,
  collectInstalledGlobalPackageErrors,
  cleanupGlobalRenameDirs,
  detectGlobalInstallManagerByPresence,
  detectGlobalInstallManagerForRoot,
  createGlobalInstallEnv,
  globalInstallArgs,
  globalInstallFallbackArgs,
  isExplicitPackageInstallSpec,
  isMainPackageTarget,
  OPENCLAW_MAIN_PACKAGE_SPEC,
  resolveGlobalInstallCommand,
  resolveGlobalPackageRoot,
  resolveGlobalInstallTarget,
  resolveGlobalInstallSpec,
  resolveGlobalRoot,
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  resolveNpmGlobalPrefixLayoutFromPrefix,
  type CommandRunner,
} from "./update-global.js";

const MATRIX_HELPER_API = bundledDistPluginFile("matrix", "helper-api.js");
async function writeGlobalPackageJson(packageRoot: string, version = "1.0.0") {
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
    "utf-8",
  );
}

async function writeBundledPluginPackageJson(
  packageRoot: string,
  pluginId: string,
  packageName: string,
) {
  const packageJsonPath = path.join(packageRoot, "dist", "extensions", pluginId, "package.json");
  await fs.mkdir(path.dirname(packageJsonPath), { recursive: true });
  await fs.writeFile(packageJsonPath, JSON.stringify({ name: packageName }), "utf-8");
}

function createNpmRootRunner(params: {
  defaultNpmRoot: string;
  overrideCommand?: string;
  overrideNpmRoot?: string;
}): CommandRunner {
  return async (argv) => {
    if (argv[0] === "npm") {
      return { stdout: `${params.defaultNpmRoot}\n`, stderr: "", code: 0 };
    }
    if (params.overrideCommand && argv[0] === params.overrideCommand) {
      return {
        stdout: `${params.overrideNpmRoot ?? params.defaultNpmRoot}\n`,
        stderr: "",
        code: 0,
      };
    }
    if (argv[0] === "pnpm") {
      return { stdout: "", stderr: "", code: 1 };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
}

describe("update global helpers", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  afterEach(() => {
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  it("prefers explicit package spec overrides", () => {
    envSnapshot = captureEnv(["OPENCLAW_UPDATE_PACKAGE_SPEC"]);
    process.env.OPENCLAW_UPDATE_PACKAGE_SPEC = "file:/tmp/openclaw.tgz";

    expect(resolveGlobalInstallSpec({ packageName: "openclaw", tag: "latest" })).toBe(
      "file:/tmp/openclaw.tgz",
    );
    expect(
      resolveGlobalInstallSpec({
        packageName: "openclaw",
        tag: "beta",
        env: { OPENCLAW_UPDATE_PACKAGE_SPEC: "openclaw@next" },
      }),
    ).toBe("openclaw@next");
  });

  it("resolves global roots and package roots from runner output", async () => {
    const runCommand: CommandRunner = async (argv) => {
      if (argv[0] === "npm") {
        return { stdout: "/tmp/npm-root\n", stderr: "", code: 0 };
      }
      if (argv[0] === "pnpm") {
        return { stdout: "", stderr: "", code: 1 };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    };

    await expect(resolveGlobalRoot("npm", runCommand, 1000)).resolves.toBe("/tmp/npm-root");
    await expect(resolveGlobalRoot("pnpm", runCommand, 1000)).resolves.toBeNull();
    await expect(resolveGlobalRoot("bun", runCommand, 1000)).resolves.toContain(
      path.join(".bun", "install", "global", "node_modules"),
    );
    await expect(resolveGlobalPackageRoot("npm", runCommand, 1000)).resolves.toBe(
      path.join("/tmp/npm-root", "openclaw"),
    );
  });

  it("maps main and explicit install specs for global installs", () => {
    expect(resolveGlobalInstallSpec({ packageName: "openclaw", tag: "main" })).toBe(
      OPENCLAW_MAIN_PACKAGE_SPEC,
    );
    expect(
      resolveGlobalInstallSpec({
        packageName: "openclaw",
        tag: "github:openclaw/openclaw#feature/my-branch",
      }),
    ).toBe("github:openclaw/openclaw#feature/my-branch");
    expect(
      resolveGlobalInstallSpec({
        packageName: "openclaw",
        tag: "https://example.com/openclaw-main.tgz",
      }),
    ).toBe("https://example.com/openclaw-main.tgz");
  });

  it("defaults corepack download prompts off for global install env", async () => {
    await expect(createGlobalInstallEnv({})).resolves.toMatchObject({
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    });

    await expect(
      createGlobalInstallEnv({
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
      }),
    ).resolves.toMatchObject({
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
    });
  });

  it("classifies main and raw install specs separately from registry selectors", () => {
    expect(isMainPackageTarget("main")).toBe(true);
    expect(isMainPackageTarget(" MAIN ")).toBe(true);
    expect(isMainPackageTarget("beta")).toBe(false);

    expect(isExplicitPackageInstallSpec("github:openclaw/openclaw#main")).toBe(true);
    expect(isExplicitPackageInstallSpec("https://example.com/openclaw-main.tgz")).toBe(true);
    expect(isExplicitPackageInstallSpec("file:/tmp/openclaw-main.tgz")).toBe(true);
    expect(isExplicitPackageInstallSpec("beta")).toBe(false);

    expect(canResolveRegistryVersionForPackageTarget("latest")).toBe(true);
    expect(canResolveRegistryVersionForPackageTarget("2026.3.22")).toBe(true);
    expect(canResolveRegistryVersionForPackageTarget("main")).toBe(false);
    expect(canResolveRegistryVersionForPackageTarget("github:openclaw/openclaw#main")).toBe(false);
  });

  it("detects install managers from resolved roots and on-disk presence", async () => {
    await withTempDir({ prefix: "openclaw-update-global-" }, async (base) => {
      const npmRoot = path.join(base, "npm-root");
      const pnpmRoot = path.join(base, "pnpm-root");
      const bunRoot = path.join(base, ".bun", "install", "global", "node_modules");
      const pkgRoot = path.join(pnpmRoot, "openclaw");
      await fs.mkdir(pkgRoot, { recursive: true });
      await fs.mkdir(path.join(npmRoot, "openclaw"), { recursive: true });
      await fs.mkdir(path.join(bunRoot, "openclaw"), { recursive: true });

      envSnapshot = captureEnv(["BUN_INSTALL"]);
      process.env.BUN_INSTALL = path.join(base, ".bun");

      const runCommand: CommandRunner = async (argv) => {
        if (argv[0] === "npm") {
          return { stdout: `${npmRoot}\n`, stderr: "", code: 0 };
        }
        if (argv[0] === "pnpm") {
          return { stdout: `${pnpmRoot}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };

      await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
        "pnpm",
      );
      await expect(detectGlobalInstallManagerByPresence(runCommand, 1000)).resolves.toBe("npm");

      await fs.rm(path.join(npmRoot, "openclaw"), { recursive: true, force: true });
      await fs.rm(path.join(pnpmRoot, "openclaw"), { recursive: true, force: true });
      await expect(detectGlobalInstallManagerByPresence(runCommand, 1000)).resolves.toBe("bun");
    });
  });

  it("prefers the owning npm prefix when PATH npm points at a different global root", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      await withTempDir({ prefix: "openclaw-update-npm-prefix-" }, async (base) => {
        const brewPrefix = path.join(base, "opt", "homebrew");
        const brewBin = path.join(brewPrefix, "bin");
        const brewRoot = path.join(brewPrefix, "lib", "node_modules");
        const pkgRoot = path.join(brewRoot, "openclaw");
        const pathNpmRoot = path.join(base, "nvm", "lib", "node_modules");
        const brewNpm = path.join(brewBin, "npm");
        await fs.mkdir(pkgRoot, { recursive: true });
        await fs.mkdir(brewBin, { recursive: true });
        await fs.writeFile(brewNpm, "", "utf8");

        const runCommand = createNpmRootRunner({
          defaultNpmRoot: pathNpmRoot,
          overrideCommand: brewNpm,
          overrideNpmRoot: brewRoot,
        });

        await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
          "npm",
        );
        await expect(resolveGlobalRoot("npm", runCommand, 1000, pkgRoot)).resolves.toBe(brewRoot);
        await expect(resolveGlobalPackageRoot("npm", runCommand, 1000, pkgRoot)).resolves.toBe(
          pkgRoot,
        );
        await expect(
          resolveGlobalInstallTarget({
            manager: "npm",
            runCommand,
            timeoutMs: 1000,
            pkgRoot,
          }),
        ).resolves.toEqual({
          manager: "npm",
          command: brewNpm,
          globalRoot: brewRoot,
          packageRoot: pkgRoot,
        });
        expect(globalInstallArgs("npm", "openclaw@latest", pkgRoot)).toEqual([
          brewNpm,
          "i",
          "-g",
          "openclaw@latest",
          "--no-fund",
          "--no-audit",
          "--loglevel=error",
        ]);
        expect(globalInstallFallbackArgs("npm", "openclaw@latest", pkgRoot)).toEqual([
          brewNpm,
          "i",
          "-g",
          "openclaw@latest",
          "--omit=optional",
          "--no-fund",
          "--no-audit",
          "--loglevel=error",
        ]);
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("does not infer npm ownership from path shape alone when the owning npm binary is absent", async () => {
    await withTempDir({ prefix: "openclaw-update-npm-missing-bin-" }, async (base) => {
      const brewRoot = path.join(base, "opt", "homebrew", "lib", "node_modules");
      const pkgRoot = path.join(brewRoot, "openclaw");
      const pathNpmRoot = path.join(base, "nvm", "lib", "node_modules");
      await fs.mkdir(pkgRoot, { recursive: true });

      const runCommand = createNpmRootRunner({ defaultNpmRoot: pathNpmRoot });

      await expect(
        detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000),
      ).resolves.toBeNull();
      expect(globalInstallArgs("npm", "openclaw@latest", pkgRoot)).toEqual([
        "npm",
        "i",
        "-g",
        "openclaw@latest",
        "--no-fund",
        "--no-audit",
        "--loglevel=error",
      ]);
    });
  });

  it("prefers npm.cmd for win32-style global npm roots", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await withTempDir({ prefix: "openclaw-update-win32-npm-prefix-" }, async (base) => {
        const npmPrefix = path.join(base, "Roaming", "npm");
        const npmRoot = path.join(npmPrefix, "node_modules");
        const pkgRoot = path.join(npmRoot, "openclaw");
        const npmCmd = path.join(npmPrefix, "npm.cmd");
        const pathNpmRoot = path.join(base, "nvm", "node_modules");
        await fs.mkdir(pkgRoot, { recursive: true });
        await fs.writeFile(npmCmd, "", "utf8");

        const runCommand = createNpmRootRunner({
          defaultNpmRoot: pathNpmRoot,
          overrideCommand: npmCmd,
          overrideNpmRoot: npmRoot,
        });

        await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
          "npm",
        );
        await expect(resolveGlobalRoot("npm", runCommand, 1000, pkgRoot)).resolves.toBe(npmRoot);
        expect(globalInstallArgs("npm", "openclaw@latest", pkgRoot)).toEqual([
          npmCmd,
          "i",
          "-g",
          "openclaw@latest",
          "--no-fund",
          "--no-audit",
          "--loglevel=error",
        ]);
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("builds install argv and npm fallback argv", () => {
    expect(resolveGlobalInstallCommand("npm")).toEqual({
      manager: "npm",
      command: "npm",
    });
    expect(globalInstallArgs("npm", "openclaw@latest")).toEqual([
      "npm",
      "i",
      "-g",
      "openclaw@latest",
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
    ]);
    expect(globalInstallArgs("pnpm", "openclaw@latest")).toEqual([
      "pnpm",
      "add",
      "-g",
      "openclaw@latest",
    ]);
    expect(globalInstallArgs("bun", "openclaw@latest")).toEqual([
      "bun",
      "add",
      "-g",
      "openclaw@latest",
    ]);

    expect(globalInstallFallbackArgs("npm", "openclaw@latest")).toEqual([
      "npm",
      "i",
      "-g",
      "openclaw@latest",
      "--omit=optional",
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
    ]);
    expect(globalInstallFallbackArgs("pnpm", "openclaw@latest")).toBeNull();
    expect(
      globalInstallArgs({ manager: "pnpm", command: "/opt/homebrew/bin/pnpm" }, "openclaw@latest"),
    ).toEqual(["/opt/homebrew/bin/pnpm", "add", "-g", "openclaw@latest"]);
  });

  it("builds npm staged install argv with an explicit prefix", () => {
    expect(globalInstallArgs("npm", "openclaw@latest", null, "/tmp/stage")).toEqual([
      "npm",
      "i",
      "-g",
      "--prefix",
      "/tmp/stage",
      "openclaw@latest",
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
    ]);
    expect(globalInstallFallbackArgs("npm", "openclaw@latest", null, "/tmp/stage")).toEqual([
      "npm",
      "i",
      "-g",
      "--prefix",
      "/tmp/stage",
      "openclaw@latest",
      "--omit=optional",
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
    ]);
  });

  it("resolves npm prefix layouts for normal global roots", () => {
    expect(resolveNpmGlobalPrefixLayoutFromGlobalRoot("/opt/openclaw/lib/node_modules")).toEqual({
      prefix: "/opt/openclaw",
      globalRoot: "/opt/openclaw/lib/node_modules",
      binDir: "/opt/openclaw/bin",
    });
    expect(resolveNpmGlobalPrefixLayoutFromPrefix("/tmp/stage")).toEqual({
      prefix: "/tmp/stage",
      globalRoot: "/tmp/stage/lib/node_modules",
      binDir: "/tmp/stage/bin",
    });
    expect(resolveNpmGlobalPrefixLayoutFromGlobalRoot("/tmp/node_modules")).toBeNull();
  });

  it("cleans only renamed package directories", async () => {
    await withTempDir({ prefix: "openclaw-update-cleanup-" }, async (root) => {
      await fs.mkdir(path.join(root, ".openclaw-123"), { recursive: true });
      await fs.mkdir(path.join(root, ".openclaw-456"), { recursive: true });
      await fs.writeFile(path.join(root, ".openclaw-file"), "nope", "utf8");
      await fs.mkdir(path.join(root, "openclaw"), { recursive: true });

      await expect(
        cleanupGlobalRenameDirs({
          globalRoot: root,
          packageName: "openclaw",
        }),
      ).resolves.toEqual({
        removed: [".openclaw-123", ".openclaw-456"],
      });
      await expect(fs.stat(path.join(root, "openclaw"))).resolves.toBeDefined();
      await expect(fs.stat(path.join(root, ".openclaw-file"))).resolves.toBeDefined();
    });
  });

  it("checks installed dist against the packaged inventory", async () => {
    await withTempDir({ prefix: "openclaw-update-global-pkg-" }, async (packageRoot) => {
      await writeGlobalPackageJson(packageRoot);
      for (const relativePath of BUNDLED_RUNTIME_SIDECAR_PATHS) {
        const absolutePath = path.join(packageRoot, relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, "export {};\n", "utf-8");
      }
      await writePackageDistInventory(packageRoot);

      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toEqual([]);

      await fs.rm(path.join(packageRoot, MATRIX_HELPER_API));
      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
        `missing packaged dist file ${MATRIX_HELPER_API}`,
      );

      await fs.writeFile(
        path.join(packageRoot, "dist", "stale-CJUAgRQR.js"),
        "export {};\n",
        "utf8",
      );
      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
        "unexpected packaged dist file dist/stale-CJUAgRQR.js",
      );
    });
  });

  it("ignores bundled plugin install stages during installed dist verification", async () => {
    await withTempDir({ prefix: "openclaw-update-global-plugin-stage-" }, async (packageRoot) => {
      await writeGlobalPackageJson(packageRoot);
      await fs.mkdir(path.join(packageRoot, "dist", "extensions", "brave"), { recursive: true });
      await writePackageDistInventory(packageRoot);

      for (const stageDir of [".openclaw-install-stage", ".openclaw-install-stage-retry"]) {
        const stagedFile = path.join(
          packageRoot,
          "dist",
          "extensions",
          "brave",
          stageDir,
          "node_modules",
          "typebox",
          "build",
          "compile",
          "code.mjs",
        );
        await fs.mkdir(path.dirname(stagedFile), { recursive: true });
        await fs.writeFile(stagedFile, "export {};\n", "utf8");
      }

      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toEqual([]);
    });
  });

  it("does not require private QA sidecars when the inventory is missing", async () => {
    await withTempDir({ prefix: "openclaw-update-global-legacy-" }, async (packageRoot) => {
      await writeGlobalPackageJson(packageRoot);

      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toEqual([]);
    });
  });

  it("fails closed on newer installs when the inventory is missing", async () => {
    await withTempDir(
      { prefix: "openclaw-update-global-missing-inventory-new-" },
      async (packageRoot) => {
        await writeGlobalPackageJson(packageRoot, "2026.4.15");

        await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
          `missing package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`,
        );
      },
    );
  });

  it("rejects invalid inventory files during global verify", async () => {
    await withTempDir(
      { prefix: "openclaw-update-global-invalid-inventory-" },
      async (packageRoot) => {
        await writeGlobalPackageJson(packageRoot, "2026.4.15");
        await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH),
          "{not-json}\n",
          "utf8",
        );

        await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
          `invalid package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`,
        );
      },
    );
  });

  it("verifies legacy sidecars for installed bundled plugins without inventory", async () => {
    await withTempDir({ prefix: "openclaw-update-global-legacy-plugin-" }, async (packageRoot) => {
      await writeGlobalPackageJson(packageRoot);
      await writeBundledPluginPackageJson(packageRoot, "matrix", "@openclaw/matrix");

      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
        `missing bundled runtime sidecar ${MATRIX_HELPER_API}`,
      );
    });
  });

  it("still enforces critical sidecars when the inventory omits them", async () => {
    await withTempDir(
      { prefix: "openclaw-update-global-critical-sidecars-" },
      async (packageRoot) => {
        await writeGlobalPackageJson(packageRoot, "2026.4.15");
        await writeBundledPluginPackageJson(packageRoot, "matrix", "@openclaw/matrix");
        await writePackageDistInventory(packageRoot);

        await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
          `missing bundled runtime sidecar ${MATRIX_HELPER_API}`,
        );
      },
    );
  });

  it("ignores stale metadata for non-packaged private QA plugins during inventory verify", async () => {
    await withTempDir(
      { prefix: "openclaw-update-global-stale-private-qa-" },
      async (packageRoot) => {
        await writeGlobalPackageJson(packageRoot, "2026.4.15");
        await writeBundledPluginPackageJson(packageRoot, "qa-lab", "@openclaw/qa-lab");
        await writePackageDistInventory(packageRoot);

        await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toEqual([]);
      },
    );
  });
});
