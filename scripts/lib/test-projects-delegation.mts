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

const repoRoot = resolveRepoRoot(import.meta.url);
const testProjectsRunnerPath = path.join(repoRoot, "scripts", "test-projects.mts");

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
  let forwardedSignal: NodeJS.Signals | null = null;
  const spawnParams = resolveTestProjectsRunnerSpawnParams(env);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", testProjectsRunnerPath, ...argv],
    spawnParams,
  );
  const teardown = installVitestProcessGroupCleanup({
    child,
    forceSignal: "SIGKILL",
    forceSignalDelayMs: 100,
    onSignal: (signal) => {
      forwardedSignal ??= signal;
    },
  });
  const completion = createVitestProcessCompletion({
    child,
    detached: spawnParams.detached,
  }).finally(teardown);
  return { child, completion, getForwardedSignal: () => forwardedSignal };
}
