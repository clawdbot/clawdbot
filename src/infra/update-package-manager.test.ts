// Covers package manager resolution for update build flows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveUpdateBuildManager } from "./update-package-manager.js";

type PackageManagerCommandRunner = Parameters<typeof resolveUpdateBuildManager>[0];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function checkout(version: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-manager-test-"));
  roots.push(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: `pnpm@${version}+sha512.test` }),
  );
  return root;
}

describe("resolveUpdateBuildManager", () => {
  it.each(["11.22.0", "12.0.0"])(
    "bootstraps the target checkout's exact pnpm %s via npm",
    async (version) => {
      const root = await checkout(version);
      const calls: string[][] = [];
      let prefix = "";
      const runCommand: PackageManagerCommandRunner = async (argv, options) => {
        calls.push(argv);
        expect(options.cwd).toBe(root);
        const key = argv.join(" ");
        if (key === "pnpm --version") {
          const envPath = options.env?.PATH ?? options.env?.Path ?? "";
          if (
            prefix &&
            envPath.split(path.delimiter)[0] === path.join(prefix, "node_modules", ".bin")
          ) {
            return { stdout: version, stderr: "", code: 0 };
          }
          return { stdout: "10.0.0", stderr: "", code: 0 };
        }
        if (key === "corepack --version") {
          throw new Error("spawn corepack ENOENT");
        }
        if (key === "npm --version") {
          return { stdout: "10.0.0", stderr: "", code: 0 };
        }
        if (key.startsWith("npm install --prefix ")) {
          prefix = argv[3] ?? "";
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
        undefined,
        "require-preferred",
      );
      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") {
        throw new Error(result.reason);
      }
      expect(result.manager).toBe("pnpm");
      expect(calls).toContainEqual(["npm", "install", "--prefix", prefix, `pnpm@${version}`]);
      await expect(fs.stat(prefix)).resolves.toBeDefined();
      await result.cleanup?.();
      await expect(fs.stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
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
