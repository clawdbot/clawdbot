// Delegates explicit test targets to the repository test-projects runner.
import { spawn, type ChildProcess } from "node:child_process";
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

export function spawnTestProjectsRunner(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: { runnerPath?: string } = {},
) {
  let forwardedSignal: NodeJS.Signals | null = null;
  const spawnParams = resolveTestProjectsRunnerSpawnParams(env);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", options.runnerPath ?? testProjectsRunnerPath, ...argv],
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

export function runTestProjectsDelegation(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: { runnerPath?: string } = {},
): ChildProcess {
  const { child, completion, getForwardedSignal } = spawnTestProjectsRunner(argv, env, options);
  completion.then(
    ({ code, signal }) => {
      const forwardedSignal = getForwardedSignal();
      if (forwardedSignal) {
        process.kill(process.pid, forwardedSignal);
        return;
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    },
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
  return child;
}
