import { describe, expect, it } from "vitest";
import {
  resolveUpdateBuildManager,
  type PackageManagerCommandRunner,
} from "./update-package-manager.js";

describe("resolveUpdateBuildManager", () => {
  it("bootstraps pnpm via npm when pnpm and corepack are unavailable", async () => {
    const paths: string[] = [];
    const runCommand: PackageManagerCommandRunner = async (argv, options) => {
      const key = argv.join(" ");
      if (key === "pnpm --version") {
        const envPath = options.env?.PATH ?? options.env?.Path ?? "";
        if (envPath.includes("openclaw-update-pnpm-")) {
          paths.push(envPath);
          return { stdout: "10.0.0", stderr: "", code: 0 };
        }
        throw new Error("spawn pnpm ENOENT");
      }
      if (key === "corepack --version") {
        throw new Error("spawn corepack ENOENT");
      }
      if (key === "npm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
      }
      if (key.startsWith("npm install --prefix ") && key.endsWith(" pnpm@10")) {
        return { stdout: "added 1 package", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await resolveUpdateBuildManager(runCommand, process.cwd(), 5000, undefined);

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.manager).toBe("pnpm");
      expect(paths).toEqual(
        expect.arrayContaining([expect.stringContaining("openclaw-update-pnpm-")]),
      );
      await result.cleanup?.();
    }
  });

  it("returns a specific bootstrap failure when pnpm cannot be installed from npm", async () => {
    const runCommand: PackageManagerCommandRunner = async (argv) => {
      const key = argv.join(" ");
      if (key === "pnpm --version") {
        throw new Error("spawn pnpm ENOENT");
      }
      if (key === "corepack --version") {
        throw new Error("spawn corepack ENOENT");
      }
      if (key === "npm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
      }
      if (key.startsWith("npm install --prefix ") && key.endsWith(" pnpm@10")) {
        return { stdout: "", stderr: "network exploded", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await resolveUpdateBuildManager(
      runCommand,
      process.cwd(),
      5000,
      undefined,
      "require-preferred",
    );

    expect(result).toEqual({
      kind: "missing-required",
      preferred: "pnpm",
      reason: "pnpm-npm-bootstrap-failed",
    });
  });
});
