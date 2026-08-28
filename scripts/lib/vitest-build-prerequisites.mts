import { spawn } from "node:child_process";
import { matchesGlob } from "node:path";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";

export type VitestPretestBuildMode = "private-qa" | "runtime";
type SetupCommandRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

type TestSelection = {
  configs?: readonly string[];
  includePatterns?: readonly string[] | null;
};

// These process tests consume built runtime artifacts. Prepare their strongest
// prerequisite before admitting any workers: a child build invalidates dist
// while unrelated workers may still be importing its public plugin facades.
// Strongest first: a private-QA build also satisfies ordinary runtime readers.
const runtimeConsumers = [
  {
    file: "extensions/qa-lab/src/suite-process-lifecycle.test.ts",
    configs: ["test/vitest/vitest.extension-qa.config.ts"],
    mode: "private-qa",
  },
  {
    file: "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts",
    configs: ["test/vitest/vitest.tooling.config.ts"],
    mode: "runtime",
  },
  {
    file: "src/gateway/gateway-active-memory.test.ts",
    configs: ["test/vitest/vitest.gateway-core.config.ts", "test/vitest/vitest.gateway.config.ts"],
    mode: "runtime",
  },
  {
    file: "src/gateway/gateway-concurrent-streams.test.ts",
    configs: ["test/vitest/vitest.gateway-core.config.ts", "test/vitest/vitest.gateway.config.ts"],
    mode: "runtime",
  },
] as const;

export function resolveVitestPretestBuildMode(
  selections: readonly TestSelection[],
): VitestPretestBuildMode | undefined {
  return runtimeConsumers.find(({ file, configs: consumerConfigs }) =>
    selections.some(({ configs, includePatterns }) =>
      includePatterns
        ? includePatterns.some((pattern) => matchesGlob(file, pattern))
        : configs?.some(
            (selected) =>
              consumerConfigs.some((config) => selected === config) ||
              selected === "vitest.config.ts" ||
              selected === "test/vitest/vitest.config.ts" ||
              fullSuiteVitestShards.some(
                (shard) =>
                  shard.config === selected &&
                  consumerConfigs.some((config) => shard.projects.includes(config)),
              ),
          ),
    ),
  )?.mode;
}

export function isE2eBuildSkipped(env: NodeJS.ProcessEnv) {
  return env.OPENCLAW_E2E_SKIP_BUILD === "1" || env.OPENCLAW_E2E_USE_PREBUILT_DIST === "1";
}

function runE2eSetupCommand(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: false,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (signal) {
        reject(new Error(`E2E setup command terminated by ${signal}: ${args.join(" ")}`));
        return;
      }
      resolve(status ?? 1);
    });
  });
}

export async function runE2eGlobalSetup(
  runCommand: SetupCommandRunner = runE2eSetupCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Focused suites may own their fixtures; prebuilt consumers already have the
  // complete surface. Neither may start another shared artifact writer.
  if (isE2eBuildSkipped(env)) {
    return;
  }
  const commands = [
    {
      args: ["scripts/run-node.mjs", "--version"],
      env: {
        ...env,
        OPENCLAW_BUILD_PRIVATE_QA: "1",
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
      },
    },
    {
      args: ["--import", "tsx", "scripts/tsdown-build.mts", "--config", "tsdown.ai.config.ts"],
      env,
    },
  ];
  for (const { args, env: commandEnv } of commands) {
    const status = await runCommand(args, commandEnv);
    if (status !== 0) {
      throw new Error(`E2E setup command failed with exit code ${status}: ${args.join(" ")}`);
    }
  }
}
