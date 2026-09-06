#!/usr/bin/env node
// Compare source revisions with one installed UI toolchain, outside artifact builds.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createControlUiPrecompressedAssetVariants } from "../ui/vite.config.ts";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "ui/package.json"));
const COMPARISON_BUILD_ENV = {
  GIT_BRANCH: "ci/control-ui-performance",
  GIT_COMMIT: "0123456789abcdef0123456789abcdef01234567",
  OPENCLAW_BUILD_TIMESTAMP: "2026-09-01T00:00:00.000Z",
  OPENCLAW_CONTROL_UI_BUILD_ID: "control-ui-performance-comparison",
  OPENCLAW_CONTROL_UI_RELEASE_BUILD: "1",
} satisfies NodeJS.ProcessEnv;

function run(command: string, args: string[], cwd = repoRoot, env = process.env): void {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed (${result.signal ?? result.status ?? "launch"})`,
      {
        cause: result.error,
      },
    );
  }
}

function resolveCommit(ref: string): string {
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0 || !/^[0-9a-f]{40}\n?$/u.test(result.stdout)) {
    throw new Error(`Cannot resolve local Control UI comparison commit: ${ref}`);
  }
  return result.stdout.trim();
}

function linkDependencies(baseRoot: string): void {
  const roots = ["", "ui"];
  for (const parent of ["packages", "extensions"]) {
    for (const entry of fs.readdirSync(path.join(repoRoot, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        roots.push(path.join(parent, entry.name));
      }
    }
  }
  for (const root of roots) {
    const dependencies = path.join(repoRoot, root, "node_modules");
    const destinationRoot = path.join(baseRoot, root);
    if (fs.existsSync(dependencies) && fs.existsSync(destinationRoot)) {
      fs.symlinkSync(dependencies, path.join(destinationRoot, "node_modules"), "junction");
    }
  }
}

function main(): void {
  const [baseRef, ...extra] = process.argv.slice(2);
  if (!baseRef || extra.length > 0 || !/^[0-9a-f]{40}$/u.test(baseRef)) {
    throw new Error("Usage: pnpm ui:check-performance:base <full-base-commit-sha>");
  }
  const base = resolveCommit(baseRef);
  const head = resolveCommit("HEAD");
  assertRealOutputRoot(path.join(repoRoot, "dist"));
  assertRealOutputRoot(path.join(repoRoot, "dist/control-ui"));
  const vitePackagePath = require.resolve("vite/package.json");
  const viteVersion = (JSON.parse(fs.readFileSync(vitePackagePath, "utf8")) as { version: string })
    .version;
  const pakoVersion = (
    JSON.parse(fs.readFileSync(require.resolve("pako/package.json"), "utf8")) as { version: string }
  ).version;
  const viteBin = path.join(path.dirname(vitePackagePath), "bin/vite.js");
  console.log(
    `Control UI comparison: working-tree head ${head}; base ${base}; Node ${process.version}; Vite ${viteVersion}; Pako ${pakoVersion}`,
  );

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ui-performance-base-"));
  try {
    const baseRoot = path.join(temporaryRoot, "source");
    const archive = path.join(temporaryRoot, "source.tar");
    const buildEnv = {
      ...process.env,
      ...COMPARISON_BUILD_ENV,
      GIT_DIR: path.join(temporaryRoot, "git-disabled"),
    };
    fs.mkdirSync(baseRoot);
    run("git", ["archive", "--format=tar", "--output", archive, base]);
    run("tar", ["-xf", archive, "-C", baseRoot]);
    linkDependencies(baseRoot);

    // Both builds use the candidate's dependency installation. Calling Vite
    // directly keeps historical policy out; one identity isolates source bytes.
    for (const root of [repoRoot, baseRoot]) {
      run(process.execPath, [viteBin, "build"], path.join(root, "ui"), buildEnv);
    }
    const loader = path.join(repoRoot, "scripts/tsx.mjs");
    run(process.execPath, [
      "--import",
      loader,
      "scripts/check-control-ui-precompressed-assets.mts",
    ]);
    const baseDist = path.join(baseRoot, "dist/control-ui");
    const baseAssets = path.join(baseDist, "assets");
    // Normalize historical CSS with the candidate's canonical compressor too:
    // dependency sharing alone cannot pin options embedded in the old config.
    for (const entry of fs.readdirSync(baseAssets, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".css")) {
        continue;
      }
      const source = fs.readFileSync(path.join(baseAssets, entry.name));
      for (const variant of createControlUiPrecompressedAssetVariants(
        `assets/${entry.name}`,
        source,
      )) {
        fs.writeFileSync(path.join(baseDist, variant.fileName), variant.source);
      }
    }
    console.log("Base CSS sidecars normalized with the candidate's canonical compressor.");
    run(process.execPath, [
      "--import",
      loader,
      "scripts/check-control-ui-performance.mts",
      "--base-dist",
      baseDist,
    ]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[control-ui-performance-base] FAILED (exit 1)");
  process.exitCode = 1;
}
