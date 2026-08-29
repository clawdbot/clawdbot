import { spawn } from "node:child_process";
import path from "node:path";
import { matchesVitestCliSelection } from "../../test/vitest/vitest.pattern-file.ts";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";
import { runManagedCommand } from "./managed-child-process.mts";

export type VitestPretestBuildMode = "private-qa" | "runtime";
type SetupCommandRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

type TestSelection = {
  configs?: readonly string[];
  includePatterns?: readonly string[] | null;
  cli?: { args: string[]; dir: string; env: NodeJS.ProcessEnv };
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
    dir: "extensions",
  },
  {
    file: "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts",
    configs: ["test/vitest/vitest.tooling.config.ts"],
    mode: "runtime",
    dir: "",
  },
  {
    file: "src/gateway/gateway-active-memory.test.ts",
    configs: ["test/vitest/vitest.gateway-core.config.ts", "test/vitest/vitest.gateway.config.ts"],
    mode: "runtime",
    dir: "src/gateway",
  },
  {
    file: "src/gateway/gateway-concurrent-streams.test.ts",
    configs: ["test/vitest/vitest.gateway-core.config.ts", "test/vitest/vitest.gateway.config.ts"],
    mode: "runtime",
    dir: "src/gateway",
  },
  {
    file: "src/gateway/gateway-terminal-cancellation.test.ts",
    configs: ["test/vitest/vitest.gateway-core.config.ts", "test/vitest/vitest.gateway.config.ts"],
    mode: "runtime",
    dir: "src/gateway",
  },
] as const;

function includesRuntimeConfig(configs: readonly string[] | undefined, config: string) {
  return configs?.some(
    (selected) =>
      selected === config ||
      selected === "vitest.config.ts" ||
      selected === "test/vitest/vitest.config.ts" ||
      fullSuiteVitestShards.some(
        (shard) => shard.config === selected && shard.projects.includes(config),
      ),
  );
}

export function resolveVitestRuntimeCliSelections(
  config: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): TestSelection[] {
  return runtimeConsumers
    .filter((consumer) =>
      consumer.configs.some((candidate) => includesRuntimeConfig([config], candidate)),
    )
    .map((consumer) => ({ configs: consumer.configs, cli: { args, dir: consumer.dir, env } }));
}

/**
 * Test files under `configs` that need a built runtime. Callers use this to keep
 * those files in one shard: the pretest build is charged per job, so spreading
 * them across stripes makes every stripe pay for it.
 */
export function listVitestRuntimeConsumerFiles(configs: readonly string[]): string[] {
  return runtimeConsumers
    .filter((consumer) =>
      consumer.configs.some((candidate) => includesRuntimeConfig(configs, candidate)),
    )
    .map((consumer) => consumer.file);
}

export function resolveVitestPretestBuildMode(
  selections: readonly TestSelection[],
): VitestPretestBuildMode | undefined {
  return runtimeConsumers.find(({ file, configs: consumerConfigs }) =>
    selections.some(({ configs, includePatterns, cli }) => {
      const included = includePatterns
        ? includePatterns.some((pattern) => path.matchesGlob(file, pattern))
        : consumerConfigs.some((config) => includesRuntimeConfig(configs, config));
      // Only project the canonical consumers; config loading and test discovery
      // stay with Vitest. Include-file overrides still intersect emitted filters.
      return cli
        ? matchesVitestCliSelection(file, included ? [file] : [], cli.args, cli.dir, cli.env)
        : included;
    }),
  )?.mode;
}

export async function prepareVitestRuntime(
  selections: readonly TestSelection[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const mode = resolveVitestPretestBuildMode(selections);
  if (!mode) {
    return 0;
  }
  console.error(`[test] preparing ${mode} runtime before Vitest workers`);
  return runManagedCommand({
    bin: process.execPath,
    args: ["scripts/run-node.mjs", "--version"],
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...env, ...(mode === "private-qa" ? { OPENCLAW_BUILD_PRIVATE_QA: "1" } : {}) },
  });
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
