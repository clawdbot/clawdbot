// Delegates explicit test targets to the repository test-projects runner.
import { spawn } from "node:child_process";
import path from "node:path";
import {
  createVitestProcessCompletion,
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "../vitest-process-group.mts";
import { resolveRepoRoot } from "./repo-root.mjs";
import { resolveVitestProcessEnv } from "./vitest-process-env.mts";

/** Builds env for the delegated test-projects runner. */
export function resolveTestProjectsRunnerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return resolveVitestProcessEnv(env);
}

/** Builds spawn options for the delegated test-projects runner. */
export function resolveTestProjectsRunnerSpawnParams(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { env: NodeJS.ProcessEnv; detached: boolean; stdio: "inherit" } {
  return {
    env: resolveTestProjectsRunnerEnv(env),
    detached: shouldUseDetachedVitestProcessGroup(platform),
    stdio: "inherit",
  };
}

export function spawnTestProjectsRunner(argv: string[], env: NodeJS.ProcessEnv) {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const testProjectsRunnerPath = path.join(repoRoot, "scripts", "test-projects-child.mts");
  const spawnParams = resolveTestProjectsRunnerSpawnParams(env);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", testProjectsRunnerPath, ...argv],
    spawnParams,
  );
  // The orchestrator must join its bounded native children and record their outcomes.
  // A competing leaf-sized force timer kills it before that cleanup can complete.
  const cleanup = installVitestProcessGroupCleanup({ child });
  const completion = createVitestProcessCompletion({
    child,
    detached: spawnParams.detached,
  }).finally(cleanup.teardown);
  return { child, completion, getForwardedSignal: cleanup.getForwardedSignal };
}
