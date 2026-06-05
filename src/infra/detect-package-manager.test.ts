// Verifies package-manager detection from lockfiles and project metadata.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { detectPackageManager } from "./detect-package-manager.js";

async function withPackageManagerRoot<T>(
  files: Array<{ path: string; content: string }>,
  run: (root: string) => Promise<T>,
): Promise<T> {
  return await withTempDir({ prefix: "openclaw-detect-pm-" }, async (root) => {
    for (const file of files) {
      const target = path.join(root, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, "utf8");
    }
    return await run(root);
  });
}

async function writePublishedOpenClawRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", packageManager: "pnpm@11.2.2" }),
    "utf8",
  );
  await fs.writeFile(path.join(root, "npm-shrinkwrap.json"), "{}", "utf8");
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

  it("keeps pnpm-owned direct package roots that ship npm-shrinkwrap", async () => {
    await withTempDir({ prefix: "openclaw-detect-pm-pnpm-direct-" }, async (base) => {
      const nodeModulesRoot = path.join(base, "pnpm-global", "node_modules");
      const packageRoot = path.join(nodeModulesRoot, "openclaw");
      await writePublishedOpenClawRoot(packageRoot);
      await fs.writeFile(path.join(nodeModulesRoot, ".modules.yaml"), "layoutVersion: 5", "utf8");

      await expect(detectPackageManager(packageRoot)).resolves.toBe("pnpm");
    });
  });

  it("keeps pnpm-owned virtual-store package roots that ship npm-shrinkwrap", async () => {
    await withTempDir({ prefix: "openclaw-detect-pm-pnpm-virtual-" }, async (base) => {
      const nodeModulesRoot = path.join(base, "project", "node_modules");
      const packageRoot = path.join(
        nodeModulesRoot,
        ".pnpm",
        "openclaw@2026.5.27",
        "node_modules",
        "openclaw",
      );
      await writePublishedOpenClawRoot(packageRoot);
      await fs.writeFile(path.join(nodeModulesRoot, ".modules.yaml"), "layoutVersion: 5", "utf8");

      await expect(detectPackageManager(packageRoot)).resolves.toBe("pnpm");
    });
  });

  it("keeps bun-owned global package roots that ship npm-shrinkwrap", async () => {
    await withTempDir({ prefix: "openclaw-detect-pm-bun-" }, async (base) => {
      const bunInstall = path.join(base, "bun-home");
      await withEnvAsync({ BUN_INSTALL: bunInstall }, async () => {
        const packageRoot = path.join(bunInstall, "install", "global", "node_modules", "openclaw");
        await writePublishedOpenClawRoot(packageRoot);

        await expect(detectPackageManager(packageRoot)).resolves.toBe("bun");
      });
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
