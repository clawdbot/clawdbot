// Package git fixture tests cover package-derived Docker git install fixtures.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

describe("package git fixture", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("stages bundled ai runtime as a local file dependency", async () => {
    const root = tempDirs.make("openclaw-package-git-fixture-");
    mkdirSync(path.join(root, "node_modules", "@openclaw", "ai"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify(
        {
          dependencies: { "@openclaw/ai": "2026.6.11", chalk: "5.6.2" },
          bundleDependencies: ["@openclaw/ai", "chalk"],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(path.join(root, "npm-shrinkwrap.json"), "{}\n");
    writeFileSync(path.join(root, ".gitignore"), "dist/temp\n");
    writeFileSync(
      path.join(root, "node_modules", "@openclaw", "ai", "package.json"),
      `${JSON.stringify({ name: "@openclaw/ai", version: "2026.6.11" })}\n`,
    );

    const result = spawnSync(
      process.execPath,
      ["scripts/e2e/lib/package-git-fixture.mjs", "prepare", root],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(packageJson.dependencies["@openclaw/ai"]).toBe("file:.openclaw-fixture/packages/ai");
    expect(packageJson.bundleDependencies).toEqual(["chalk"]);
    expect(() => readFileSync(path.join(root, "npm-shrinkwrap.json"), "utf8")).toThrow();
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(
      "dist/temp\nnode_modules/\n/pnpm-lock.yaml\n",
    );
    expect(
      JSON.parse(
        readFileSync(
          path.join(root, ".openclaw-fixture", "packages", "ai", "package.json"),
          "utf8",
        ),
      ).name,
    ).toBe("@openclaw/ai");

    mkdirSync(path.join(root, "node_modules", "fixture-dependency"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "fixture-dependency", "package.json"), "{}\n");
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    expect(
      spawnSync("git", [
        "-C",
        root,
        "check-ignore",
        "-q",
        "node_modules/fixture-dependency/package.json",
      ]).status,
    ).toBe(0);
    expect(spawnSync("git", ["-C", root, "check-ignore", "-q", "pnpm-lock.yaml"]).status).toBe(0);
  });
});
