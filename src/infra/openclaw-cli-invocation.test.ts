import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveCurrentOpenClawCliInvocation } from "./openclaw-cli-invocation.js";

const requireFromHere = createRequire(import.meta.url);
const repoRoot = process.cwd();
const repoSourceEntry = path.join(repoRoot, "src", "entry.ts");
const trustedTsxLoader = requireFromHere.resolve("tsx", { paths: [repoRoot] });
const commandArgs = ["sessions", "export-trajectory"];

describe("resolveCurrentOpenClawCliInvocation", () => {
  it("uses the source entry for a Node-hosted checkout harness", () => {
    expect(
      resolveCurrentOpenClawCliInvocation(commandArgs, {
        argv1: path.join(repoRoot, "scripts", "test-live.mjs"),
        cwd: repoRoot,
        execArgv: [],
        execPath: "/usr/bin/node",
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["--import", trustedTsxLoader, repoSourceEntry, ...commandArgs],
      cwd: repoRoot,
    });
  });

  it("uses the source entry directly under Bun", () => {
    expect(
      resolveCurrentOpenClawCliInvocation(commandArgs, {
        argv1: path.join(repoRoot, "scripts", "test-live.mjs"),
        cwd: repoRoot,
        execPath: "/usr/local/bin/bun",
      }),
    ).toEqual({
      command: "/usr/local/bin/bun",
      args: [repoSourceEntry, ...commandArgs],
      cwd: repoRoot,
    });
  });

  it("preserves launcher argv and execArgv from the current checkout", () => {
    const launcher = path.join(repoRoot, "openclaw.mjs");
    expect(
      resolveCurrentOpenClawCliInvocation(commandArgs, {
        argv1: launcher,
        cwd: path.join(repoRoot, "src"),
        execArgv: ["--trace-warnings"],
        execPath: "/usr/bin/node",
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["--trace-warnings", launcher, ...commandArgs],
      cwd: repoRoot,
    });
  });

  it("preserves package entry argv from the current checkout", () => {
    const distEntry = path.join(repoRoot, "dist", "entry.js");
    expect(
      resolveCurrentOpenClawCliInvocation(commandArgs, {
        argv1: distEntry,
        cwd: repoRoot,
        execArgv: ["--enable-source-maps"],
        execPath: "/usr/bin/node",
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["--enable-source-maps", distEntry, ...commandArgs],
      cwd: repoRoot,
    });
  });

  it("uses the installed wrapper and canonical package cwd", async () => {
    await withTempDir("openclaw-cli-invocation-", async (packageRoot) => {
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
      const moduleUrl = pathToFileURL(path.join(packageRoot, "dist", "tui", "index.js")).href;
      expect(
        resolveCurrentOpenClawCliInvocation(commandArgs, {
          argv1: path.join(packageRoot, "bin", "host.mjs"),
          cwd: path.join(packageRoot, "state"),
          execPath: "/usr/bin/node",
          moduleUrl,
        }),
      ).toEqual({
        command: "/usr/bin/node",
        args: [path.join(packageRoot, "openclaw.mjs"), ...commandArgs],
        cwd: packageRoot,
      });
    });
  });

  it("does not preserve a foreign package entry", () => {
    expect(
      resolveCurrentOpenClawCliInvocation(commandArgs, {
        argv1: "/app/dist/index.js",
        cwd: repoRoot,
        execPath: "/usr/bin/node",
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["--import", trustedTsxLoader, repoSourceEntry, ...commandArgs],
      cwd: repoRoot,
    });
  });

  it("does not preserve a foreign launcher basename", () => {
    expect(
      resolveCurrentOpenClawCliInvocation(commandArgs, {
        argv1: "/other/openclaw.mjs",
        cwd: repoRoot,
        execPath: "/usr/bin/node",
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["--import", trustedTsxLoader, repoSourceEntry, ...commandArgs],
      cwd: repoRoot,
    });
  });
});
