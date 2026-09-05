import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TestProject } from "vitest/node";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
  resolveGitHead,
} from "../../scripts/lib/local-build-metadata.mts";
import { runNodeConfigFiles, runNodeSourceRoots } from "../../scripts/run-node-watch-paths.mts";
import {
  resolveBuildRequirement,
  resolveRuntimePostBuildRequirement,
} from "../../scripts/run-node.mts";
import { inspectControlUiRootAssets } from "../../src/infra/control-ui-assets.ts";

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2ePrebuiltGeneration: string;
  }
}

export function assertPrebuiltUiE2eRuntime(repoRoot: string): string {
  const fail = (reason: string): never => {
    throw new Error(
      `Prebuilt UI E2E requires a completed OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build:ci-artifacts on a clean checkout (${reason}). Use vitest.ui-e2e.config.ts for ordinary local tests.`,
    );
  };
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_BUILD_PRIVATE_QA: "1" };
  env.OPENCLAW_DEV_SOURCE_ROOT ??= repoRoot;
  const readGitEnv = {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  const readOnlySpawn: Parameters<typeof resolveBuildRequirement>[0]["spawnSync"] = (
    command,
    args,
    options,
  ) => spawnSync(command, args, { ...options, env: readGitEnv });
  const head =
    resolveGitHead({ cwd: repoRoot, spawnSync: readOnlySpawn }) ?? fail("Git HEAD is unavailable");
  const dirty = readOnlySpawn("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (dirty.status !== 0 || dirty.stdout?.trim()) {
    fail("source state is dirty or unavailable");
  }
  const distRoot = path.join(repoRoot, "dist");
  const deps = {
    cwd: repoRoot,
    env,
    fs,
    spawnSync: readOnlySpawn,
    distRoot,
    distEntry: path.join(distRoot, "entry.js"),
    buildStampPath: path.join(distRoot, BUILD_STAMP_FILE),
    runtimePostBuildStampPath: path.join(distRoot, RUNTIME_POSTBUILD_STAMP_FILE),
    configFiles: runNodeConfigFiles.map((file) => path.join(repoRoot, file)),
    sourceRoots: runNodeSourceRoots.map((name) => ({ name, path: path.join(repoRoot, name) })),
  };
  const build = resolveBuildRequirement(deps);
  if (build.shouldBuild) {
    fail(build.reason);
  }
  const runtime = resolveRuntimePostBuildRequirement(deps);
  if (runtime.shouldSync) {
    fail(runtime.reason);
  }
  const uiRoot = path.join(distRoot, "control-ui");
  if (inspectControlUiRootAssets(uiRoot).kind !== "ready") {
    fail("canonical Control UI assets are not ready");
  }
  const digest = createHash("sha256").update(head);
  for (const file of [
    deps.buildStampPath,
    deps.runtimePostBuildStampPath,
    path.join(distRoot, "build-info.json"),
    path.join(uiRoot, "index.html"),
    path.join(uiRoot, "asset-manifest.json"),
  ]) {
    digest.update(fs.readFileSync(file));
  }
  return digest.digest("hex");
}

export default function setup(project: TestProject) {
  const root = project.vitest.getRootProject();
  if (root.getProvidedContext().controlUiE2ePrebuiltGeneration !== undefined) {
    return undefined;
  }
  // CI's successful artifact step owns preparation. Never repair outputs while
  // parallel Gateway readers are live; the normal local config remains serial.
  const before = assertPrebuiltUiE2eRuntime(root.config.root);
  root.provide("controlUiE2ePrebuiltGeneration", before);
  return () => {
    try {
      if (assertPrebuiltUiE2eRuntime(root.config.root) !== before) {
        throw new Error("Prebuilt UI E2E runtime generation changed during the run");
      }
    } catch (error) {
      // Vitest logs teardown errors without failing an otherwise successful CLI.
      process.exitCode = 1;
      throw error;
    }
  };
}
