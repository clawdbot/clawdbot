// Verifies package-manager detection from lockfiles and project metadata.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { detectPackageManager } from "./detect-package-manager.js";

async function withPackageManagerRoot<T>(
  files: Array<{ path: string; content: string }>,
  run: (root: string) => Promise<T>,
): Promise<T> {
  return await withTestDir({ prefix: "openclaw-detect-pm-" }, async (root) => {
    for (const file of files) {
      const target = path.join(root, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, "utf8");
    }
    return await run(root);
  });
}

async function writePublishedOpenClawRoot(
  root: string,
  options: { shrinkwrap: boolean },
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", packageManager: "pnpm@11.2.2" }),
    "utf8",
  );
  if (options.shrinkwrap) {
    await fs.writeFile(path.join(root, "npm-shrinkwrap.json"), "{}", "utf8");
  }
}

describe("detectPackageManager", () => {
  it("prefers packageManager from package.json when supported", async () => {
    await withPackageManagerRoot(
      [
        { path: "package.json", content: JSON.stringify({ packageManager: "pnpm@10.8.1" }) },
        { path: "package-lock.json", content: "" },
      ],
      async (root) => {
        await expect(detectPackageManager(root)).resolves.toBe("pnpm");
      },
    );
  });

  it.each([
    {
      name: "uses bun.lock",
      files: [{ path: "bun.lock", content: "" }],
      expected: "bun",
    },
    {
      name: "uses bun.lockb",
      files: [{ path: "bun.lockb", content: "" }],
      expected: "bun",
    },
    {
      name: "falls back to npm lockfiles for unsupported packageManager values",
      files: [
        { path: "package.json", content: JSON.stringify({ packageManager: "yarn@4.0.0" }) },
        { path: "package-lock.json", content: "" },
      ],
      expected: "npm",
    },
  ])("falls back to lockfiles when $name", async ({ files, expected }) => {
    await withPackageManagerRoot(files, async (root) => {
      await expect(detectPackageManager(root)).resolves.toBe(expected);
    });
  });

  it("uses npm-shrinkwrap as npm evidence for published npm package roots", async () => {
    await withPackageManagerRoot(
      [
        { path: "package.json", content: JSON.stringify({ packageManager: "pnpm@11.2.2" }) },
        { path: "npm-shrinkwrap.json", content: "{}" },
      ],
      async (root) => {
        await expect(detectPackageManager(root)).resolves.toBe("npm");
      },
    );
  });

  it("keeps pnpm source roots when npm-shrinkwrap is present next to pnpm-lock", async () => {
    await withPackageManagerRoot(
      [
        { path: "package.json", content: JSON.stringify({ packageManager: "pnpm@11.2.2" }) },
        { path: "npm-shrinkwrap.json", content: "{}" },
        { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'" },
      ],
      async (root) => {
        await expect(detectPackageManager(root)).resolves.toBe("pnpm");
      },
    );
  });

  it.each(
    [
      { manager: "pnpm", layout: "direct" },
      { manager: "pnpm", layout: "virtual" },
      { manager: "bun", layout: "global" },
    ].flatMap((scenario) => [
      { ...scenario, packageFormat: "lockless", shrinkwrap: false },
      { ...scenario, packageFormat: "legacy shrinkwrapped", shrinkwrap: true },
    ]),
  )(
    "detects $manager ownership for $packageFormat packages in $layout layouts",
    async ({ manager, layout, shrinkwrap }) => {
      await withTestDir({ prefix: `openclaw-detect-pm-${manager}-` }, async (base) => {
        const bunInstall = path.join(base, "custom-bun-home");
        const nodeModulesRoot =
          manager === "bun"
            ? path.join(bunInstall, "install", "global", "node_modules")
            : path.join(base, `${manager}-global`, "node_modules");
        const packageRoot =
          layout === "virtual"
            ? path.join(nodeModulesRoot, ".pnpm", "openclaw@2026.5.27", "node_modules", "openclaw")
            : path.join(nodeModulesRoot, "openclaw");
        await writePublishedOpenClawRoot(packageRoot, { shrinkwrap });
        if (manager === "pnpm") {
          await fs.writeFile(
            path.join(nodeModulesRoot, ".modules.yaml"),
            "layoutVersion: 5",
            "utf8",
          );
        }

        await withEnvAsync({ BUN_INSTALL: bunInstall }, async () => {
          await expect(detectPackageManager(packageRoot)).resolves.toBe(manager);
        });
      });
    },
  );

  it.each([
    { name: "missing Bun install environment", installEnv: "missing", customGlobalDir: false },
    {
      name: "conflicting Bun install environment",
      installEnv: "conflicting",
      customGlobalDir: false,
    },
    {
      name: "explicit custom Bun global directory",
      installEnv: "conflicting",
      customGlobalDir: true,
    },
  ] as const)(
    "detects lockless Bun ownership with $name",
    async ({ installEnv, customGlobalDir }) => {
      await withTestDir({ prefix: "openclaw-detect-pm-bun-owner-" }, async (base) => {
        const bunInstall = path.join(base, "owning-bun");
        const globalProject = customGlobalDir
          ? path.join(base, "custom-global-project")
          : path.join(bunInstall, "install", "global");
        const packageRoot = path.join(globalProject, "node_modules", "openclaw");
        await writePublishedOpenClawRoot(packageRoot, { shrinkwrap: false });

        await withEnvAsync(
          {
            BUN_INSTALL: installEnv === "missing" ? undefined : path.join(base, "unrelated-bun"),
            BUN_INSTALL_GLOBAL_DIR: customGlobalDir ? globalProject : undefined,
          },
          async () => {
            await expect(detectPackageManager(packageRoot)).resolves.toBe("bun");
          },
        );
      });
    },
  );

  it("keeps pnpm 11 ownership through markerless global virtual-store symlinks", async () => {
    await withTestDir({ prefix: "openclaw-detect-pm-pnpm-global-store-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const installRoot = path.join(globalRoot, "install-openclaw");
      const linkedPackageRoot = path.join(installRoot, "node_modules", "openclaw");
      const storePackageRoot = path.join(
        base,
        "pnpm-home",
        "store",
        "v11",
        "links",
        "@",
        "openclaw",
        "2026.7.2",
        "graph-hash",
        "node_modules",
        "openclaw",
      );
      await writePublishedOpenClawRoot(storePackageRoot, { shrinkwrap: false });
      await fs.mkdir(path.dirname(linkedPackageRoot), { recursive: true });
      await fs.writeFile(
        path.join(installRoot, "package.json"),
        JSON.stringify({ private: true, dependencies: { openclaw: "2026.7.2" } }),
        "utf8",
      );
      await fs.writeFile(path.join(installRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(storePackageRoot, linkedPackageRoot, symlinkType);
      await fs.symlink(installRoot, path.join(globalRoot, "hash-openclaw"), symlinkType);

      await expect(detectPackageManager(linkedPackageRoot)).resolves.toBe("pnpm");
      await expect(detectPackageManager(await fs.realpath(linkedPackageRoot))).resolves.toBe(
        "pnpm",
      );
    });
  });

  it("returns null when no package manager markers exist", async () => {
    await withPackageManagerRoot(
      [{ path: "package.json", content: "{not-json}" }],
      async (root) => {
        await expect(detectPackageManager(root)).resolves.toBeNull();
      },
    );
  });
});
