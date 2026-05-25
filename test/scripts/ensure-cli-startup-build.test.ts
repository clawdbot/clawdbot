import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureCliStartupBuild,
  hasCliStartupBuild,
} from "../../scripts/ensure-cli-startup-build.mjs";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-cli-startup-build-"));
  tempRoots.push(root);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "build-all.mjs"), "", "utf8");
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ensure-cli-startup-build", () => {
  it("detects an existing CLI startup build", () => {
    const root = makeTempRoot();
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "dist", "entry.js"), "export {};\n", "utf8");

    expect(hasCliStartupBuild({ rootDir: root })).toBe(true);
  });

  it("skips the build profile when dist entry output already exists", () => {
    const root = makeTempRoot();
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "dist", "entry.mjs"), "export {};\n", "utf8");

    const result = ensureCliStartupBuild({
      rootDir: root,
      spawnSync: () => {
        throw new Error("unexpected build");
      },
    });

    expect(result).toEqual({ built: false });
  });

  it("runs the cliStartup build profile when dist entry output is missing", () => {
    const root = makeTempRoot();
    const calls: unknown[] = [];

    const result = ensureCliStartupBuild({
      rootDir: root,
      nodeExecPath: "/node",
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
      stdio: "pipe",
    });

    expect(result).toEqual({ built: true });
    expect(calls).toEqual([
      {
        command: "/node",
        args: [path.join(root, "scripts", "build-all.mjs"), "cliStartup"],
        options: expect.objectContaining({
          cwd: root,
          stdio: "pipe",
        }),
      },
    ]);
  });

  it("fails when the cliStartup build profile fails", () => {
    const root = makeTempRoot();

    expect(() =>
      ensureCliStartupBuild({
        rootDir: root,
        spawnSync: () => ({ status: 1 }),
        stdio: "pipe",
      }),
    ).toThrow("cliStartup build profile failed with exit code 1");
  });
});
