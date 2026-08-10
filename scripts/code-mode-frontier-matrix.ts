#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  buildCodeModeMatrixCliArtifacts,
  hashCodeModeMatrixRuntimeArtifacts,
  prepareCodeModeMatrixRuntimeEntrypoint,
  readCodeModeMatrixSourceIdentity,
  runCodeModeMatrixFrontierCell,
  type MatrixRuntimeEntrypoint,
  type MatrixTaskFixture,
  type SourceIdentity,
} from "./code-mode-model-matrix.js";
import {
  buildFrontierModeConfigProof,
  buildFrozenFrontierMatrixPlan,
  digestJson,
  runFrozenFrontierMatrix,
  sha256,
  type FrontierExecutionProof,
  type FrontierMatrixCellObservation,
  type FrontierTaskDescriptor,
  type FrozenFrontierMatrixCell,
  type FrozenFrontierMatrixIdentity,
  type FrozenFrontierMatrixPlan,
} from "./lib/code-mode-frontier-matrix.js";

const DEFAULT_TIMEOUT_SECONDS = 180;
const FRONTIER_AGENT_ID = "main";
const FRONTIER_TASKS = {
  read: {
    expected: "CM-FRONTIER-READ",
    prompt:
      "Read facts.txt using tools. Reply with only the verification_code value, with no prose or formatting.",
  },
  "dependent-read-write": {
    expected: "CM-FRONTIER-WRITE",
    prompt:
      "Read facts.txt using tools. Write only its verification_code value to result.txt, then read result.txt and reply with only that value. Do not guess or skip verification.",
    resultPath: "result.txt",
  },
} as const satisfies Record<string, MatrixTaskFixture>;

type FrontierTaskId = keyof typeof FRONTIER_TASKS;
type FrontierThinkingLevel = NonNullable<
  NonNullable<OpenClawConfig["agents"]>["defaults"]
>["thinkingDefault"];

export type CodeModeFrontierOptions = {
  api: string;
  blockId: string;
  campaignId: string;
  executionProofPath: string;
  model: string;
  modelCapabilityPath: string;
  outputDir?: string;
  repoRoot: string;
  runDate?: string;
  sampling: {
    seed: string;
    seedSupport: "supported" | "unsupported";
  };
  tasks: FrontierTaskId[];
  thinking: string;
  timeoutSeconds: number;
};

type FrontierOperatorDependencies = {
  buildCliArtifacts?: (repoRoot: string) => Promise<void>;
  hashRuntimeArtifacts?: (repoRoot: string) => Promise<string>;
  now?: () => Date;
  nonce?: () => string;
  prepareRuntimeEntrypoint?: (
    repoRoot: string,
    runtimeRoot: string,
  ) => Promise<MatrixRuntimeEntrypoint>;
  readFileSha256?: (filePath: string) => Promise<string>;
  readSourceIdentity?: (repoRoot: string) => Promise<SourceIdentity>;
  runAgentCell?: (params: {
    cell: FrozenFrontierMatrixCell;
    fixture: MatrixTaskFixture;
    outputDir: string;
    plan: FrozenFrontierMatrixPlan;
    repoRoot: string;
    runtime: MatrixRuntimeEntrypoint;
  }) => Promise<{
    effectPassed: boolean;
    envelope: unknown;
    stdoutContractValid: boolean;
  }>;
};

function usage(): string {
  return `Usage: pnpm qa:code-mode-frontier -- --model <provider/model> --api <api> \\
  --campaign-id <id> --block-id <id> --execution-proof <repo-relative.json> \\
  --model-capability <repo-relative.json> [options]

Runs a frozen supported-frontier Direct/Code ABBA comparison through real isolated agent exec cells.

Options:
  --task <task>             read | dependent-read-write; repeat to select tasks
  --thinking <level>        Agent thinking level (default: off)
  --timeout <seconds>       Per-run agent deadline (default: ${DEFAULT_TIMEOUT_SECONDS})
  --seed-support <value>    supported | unsupported (default: unsupported)
  --seed <value>            Exact provider seed identity (default: unset)
  --run-date <YYYY-MM-DD>   Expected UTC start date (default: current UTC date)
  --output-dir <path>       Repo-relative artifact directory
  -h, --help                Show this help

The execution-proof JSON records verified retry and warm/cold policy. Provider credentials remain environment-only.
`;
}

function optionValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function taskId(value: string): FrontierTaskId {
  if (value === "read" || value === "dependent-read-write") {
    return value;
  }
  throw new Error(`--task must be read or dependent-read-write; got ${JSON.stringify(value)}`);
}

function positiveInteger(value: string, flag: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 3_600) {
    throw new Error(`${flag} must be an integer from 1 to 3600`);
  }
  return parsed;
}

export function parseCodeModeFrontierOptions(
  argv: readonly string[],
  cwd = process.cwd(),
): CodeModeFrontierOptions {
  const values = new Map<string, string>();
  const tasks: FrontierTaskId[] = [];
  let seed = "unset";
  let seedSupport: "supported" | "unsupported" = "unsupported";
  let thinking = "off";
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--" && index === 0) {
      continue;
    }
    if (arg === "--task") {
      const value = taskId(optionValue(argv, index, arg));
      if (tasks.includes(value)) {
        throw new Error(`Duplicate --task value: ${value}`);
      }
      tasks.push(value);
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      timeoutSeconds = positiveInteger(optionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--thinking") {
      thinking = optionValue(argv, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg === "--seed-support") {
      const value = optionValue(argv, index, arg);
      if (value !== "supported" && value !== "unsupported") {
        throw new Error("--seed-support must be supported or unsupported");
      }
      seedSupport = value;
      index += 1;
      continue;
    }
    if (arg === "--seed") {
      seed = optionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw Object.assign(new Error(usage()), { code: "HELP" });
    }
    if (
      arg === "--api" ||
      arg === "--block-id" ||
      arg === "--campaign-id" ||
      arg === "--execution-proof" ||
      arg === "--model" ||
      arg === "--model-capability" ||
      arg === "--output-dir" ||
      arg === "--run-date"
    ) {
      if (values.has(arg)) {
        throw new Error(`${arg} was provided more than once`);
      }
      values.set(arg, optionValue(argv, index, arg));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  const required = [
    "--api",
    "--block-id",
    "--campaign-id",
    "--execution-proof",
    "--model",
    "--model-capability",
  ];
  for (const flag of required) {
    if (!values.get(flag)?.trim()) {
      throw new Error(`${flag} is required`);
    }
  }
  const model = values.get("--model")!.trim();
  if (!/^[^/]+\/[^/]+/u.test(model)) {
    throw new Error("--model must use provider/model form");
  }
  return {
    api: values.get("--api")!.trim(),
    blockId: values.get("--block-id")!.trim(),
    campaignId: values.get("--campaign-id")!.trim(),
    executionProofPath: values.get("--execution-proof")!,
    model,
    modelCapabilityPath: values.get("--model-capability")!,
    ...(values.get("--output-dir") ? { outputDir: values.get("--output-dir") } : {}),
    repoRoot: path.resolve(cwd),
    ...(values.get("--run-date") ? { runDate: values.get("--run-date") } : {}),
    sampling: { seed, seedSupport },
    tasks: tasks.length > 0 ? tasks : ["read", "dependent-read-write"],
    thinking,
    timeoutSeconds,
  };
}

async function resolveRepoInput(repoRoot: string, configured: string): Promise<string> {
  if (path.isAbsolute(configured)) {
    throw new Error("--execution-proof must be repo-relative");
  }
  const root = await fs.realpath(repoRoot);
  const resolved = await fs.realpath(path.resolve(root, configured));
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("--execution-proof must stay within the repository");
  }
  return resolved;
}

async function readExecutionProof(filePath: string): Promise<FrontierExecutionProof> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<FrontierExecutionProof>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.providerRetry ||
    !parsed.encryptedPayloadRecovery ||
    !parsed.transportRetry ||
    !parsed.warmCold
  ) {
    throw new Error("frontier execution proof is incomplete");
  }
  const providerRetry = parsed.providerRetry;
  const encryptedPayloadRecovery = parsed.encryptedPayloadRecovery;
  const transportRetry = parsed.transportRetry;
  const warmCold = parsed.warmCold;
  if (
    (providerRetry.status !== "verified" && providerRetry.status !== "declared_unverified") ||
    !Number.isSafeInteger(providerRetry.maxRetries) ||
    providerRetry.maxRetries < 0 ||
    (encryptedPayloadRecovery.status !== "disabled" &&
      encryptedPayloadRecovery.status !== "mandatory") ||
    !Number.isSafeInteger(encryptedPayloadRecovery.maxRecoveries) ||
    encryptedPayloadRecovery.maxRecoveries < 0 ||
    (transportRetry.status !== "verified" && transportRetry.status !== "unknown") ||
    (transportRetry.maxRetries !== null &&
      (!Number.isSafeInteger(transportRetry.maxRetries) || transportRetry.maxRetries < 0)) ||
    warmCold.build !== "warm_shared_immutable" ||
    warmCold.gatewayProcess !== "cold_per_cell" ||
    warmCold.openClawState !== "cold_fresh_per_cell" ||
    warmCold.providerFirstCallCache !== "observed_per_trace" ||
    (warmCold.transportPrewarm !== "observed_disabled" &&
      warmCold.transportPrewarm !== "unobserved") ||
    (warmCold.transportReuse !== "observed_disabled" && warmCold.transportReuse !== "unobserved")
  ) {
    throw new Error("frontier execution proof contains invalid policy values");
  }
  return {
    providerRetry: {
      status: providerRetry.status,
      maxRetries: providerRetry.maxRetries,
    },
    encryptedPayloadRecovery: {
      status: encryptedPayloadRecovery.status,
      maxRecoveries: encryptedPayloadRecovery.maxRecoveries,
    },
    transportRetry: {
      status: transportRetry.status,
      maxRetries: transportRetry.maxRetries,
    },
    warmCold: {
      build: warmCold.build,
      gatewayProcess: warmCold.gatewayProcess,
      openClawState: warmCold.openClawState,
      providerFirstCallCache: warmCold.providerFirstCallCache,
      transportPrewarm: warmCold.transportPrewarm,
      transportReuse: warmCold.transportReuse,
    },
  };
}

async function readModelCapabilityProof(
  filePath: string,
  options: CodeModeFrontierOptions,
): Promise<{
  api: string;
  model: string;
  seedSupport: "supported" | "unsupported";
  supportedFrontier: true;
}> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  if (
    parsed.model !== options.model ||
    parsed.api !== options.api ||
    parsed.seedSupport !== options.sampling.seedSupport ||
    parsed.supportedFrontier !== true
  ) {
    throw new Error("model capability proof does not authorize this supported-frontier run");
  }
  return {
    api: options.api,
    model: options.model,
    seedSupport: options.sampling.seedSupport,
    supportedFrontier: true,
  };
}

async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

function taskFixtureContents(task: FrontierTaskId): string {
  return `project=openclaw\nverification_code=${FRONTIER_TASKS[task].expected}\n`;
}

export function buildCodeModeFrontierTaskDescriptors(
  tasks: readonly FrontierTaskId[],
): FrontierTaskDescriptor[] {
  return tasks.map((task) => {
    const fixture = FRONTIER_TASKS[task];
    return {
      id: task,
      fixtureSha256: sha256(taskFixtureContents(task)),
      promptSha256: sha256(fixture.prompt),
      oracleSha256: digestJson({
        answer: fixture.expected,
        effect: "resultPath" in fixture ? fixture.resultPath : null,
      }),
    };
  });
}

function modeConfig(options: CodeModeFrontierOptions, enabled: boolean): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: options.model, fallbacks: [] },
        thinkingDefault: options.thinking as FrontierThinkingLevel,
        experimental: { localModelLean: false },
      },
      entries: {
        [FRONTIER_AGENT_ID]: {
          model: options.model,
          thinkingDefault: options.thinking as FrontierThinkingLevel,
          experimental: { localModelLean: false },
          tools: { codeMode: { enabled } },
        },
      },
    },
    tools: { codeMode: { enabled } },
  };
}

function observedReceipt(
  cell: FrozenFrontierMatrixCell,
  plan: FrozenFrontierMatrixPlan,
): FrontierMatrixCellObservation["receipt"] {
  const task = plan.task.manifest[cell.taskIndex]!;
  return {
    cellId: cell.id,
    cellStateKey: cell.stateKey,
    taskId: cell.taskId,
    taskIndex: cell.taskIndex,
    taskSha256: cell.taskSha256,
    fixtureSha256: task.fixtureSha256,
    promptSha256: task.promptSha256,
    oracleSha256: task.oracleSha256,
    modeConfigSha256:
      cell.mode === "direct"
        ? plan.execution.modeConfigProof.directSha256
        : plan.execution.modeConfigProof.codeSha256,
  };
}

export async function runCodeModeFrontierMatrix(
  options: CodeModeFrontierOptions,
  deps: FrontierOperatorDependencies = {},
) {
  const now = deps.now?.() ?? new Date();
  const runDate = options.runDate ?? now.toISOString().slice(0, 10);
  const readSourceIdentity = deps.readSourceIdentity ?? readCodeModeMatrixSourceIdentity;
  const initialSource = await readSourceIdentity(options.repoRoot);
  if (initialSource.sourceDirty) {
    throw new Error("frontier matrix requires a clean source checkout");
  }
  const executionProof = await readExecutionProof(
    await resolveRepoInput(options.repoRoot, options.executionProofPath),
  );
  const modelCapability = await readModelCapabilityProof(
    await resolveRepoInput(options.repoRoot, options.modelCapabilityPath),
    options,
  );
  await (deps.buildCliArtifacts ?? buildCodeModeMatrixCliArtifacts)(options.repoRoot);
  const hashRuntime = deps.hashRuntimeArtifacts ?? hashCodeModeMatrixRuntimeArtifacts;
  const readFileHash = deps.readFileSha256 ?? fileSha256;
  const modeConfigProof = buildFrontierModeConfigProof({
    agentId: FRONTIER_AGENT_ID,
    direct: modeConfig(options, false),
    code: modeConfig(options, true),
  });
  const runner = {
    localModelLean: false as const,
    thinking: options.thinking,
    timeoutSeconds: options.timeoutSeconds,
  };
  const stableIdentity = {
    configSha256: digestJson({ base: modeConfigProof.baseSha256, runner }),
    modelCapabilitySha256: digestJson(modelCapability),
  };
  const readIdentity = async (): Promise<FrozenFrontierMatrixIdentity> => {
    const source = await readSourceIdentity(options.repoRoot);
    if (source.sourceDirty) {
      throw new Error("frontier matrix source changed during execution");
    }
    return {
      sourceSha: source.gitSha,
      sourceDirty: false,
      buildSha256: await hashRuntime(options.repoRoot),
      configSha256: stableIdentity.configSha256,
      entrypointSha256: await readFileHash(path.join(options.repoRoot, "dist", "entry.js")),
      lockfileSha256: await readFileHash(path.join(options.repoRoot, "pnpm-lock.yaml")),
      modelCapabilitySha256: stableIdentity.modelCapabilitySha256,
      nodeVersion: process.version,
    };
  };
  const identity = await readIdentity();
  const plan = buildFrozenFrontierMatrixPlan({
    api: options.api,
    blockId: options.blockId,
    campaignId: options.campaignId,
    campaignNonce: deps.nonce?.() ?? randomUUID(),
    executionProof,
    identity,
    modeConfigProof,
    model: options.model,
    runDate,
    runner,
    sampling: options.sampling,
    tasks: buildCodeModeFrontierTaskDescriptors(options.tasks),
  });
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-runtime-"));
  try {
    const runtime = await (deps.prepareRuntimeEntrypoint ?? prepareCodeModeMatrixRuntimeEntrypoint)(
      options.repoRoot,
      runtimeRoot,
    );
    const runAgentCell =
      deps.runAgentCell ??
      (async (params: Parameters<NonNullable<FrontierOperatorDependencies["runAgentCell"]>>[0]) =>
        await runCodeModeMatrixFrontierCell({
          cell: {
            id: params.cell.id,
            mode: params.cell.mode,
            model: params.plan.model.ref,
            repetition: params.cell.repetition,
            task: params.cell.taskId as FrontierTaskId,
          },
          fixture: params.fixture,
          outputDir: params.outputDir,
          repoRoot: params.repoRoot,
          runtime: params.runtime,
          thinking: params.plan.execution.runner.thinking,
          timeoutSeconds: params.plan.execution.runner.timeoutSeconds,
        }));
    return await runFrozenFrontierMatrix({
      repoRoot: options.repoRoot,
      outputDir:
        options.outputDir ??
        path.join(
          ".artifacts",
          "qa-e2e",
          "code-mode-frontier",
          now.toISOString().replaceAll(":", "-"),
        ),
      plan,
      deps: {
        evidenceSource: "production",
        readIdentity,
        runCell: async (cell, currentPlan) => {
          const fixture = FRONTIER_TASKS[cell.taskId as FrontierTaskId];
          if (!fixture) {
            throw new Error(`unsupported frontier task: ${cell.taskId}`);
          }
          const result = await runAgentCell({
            cell,
            fixture,
            outputDir: options.outputDir ?? "",
            plan: currentPlan,
            repoRoot: options.repoRoot,
            runtime,
          });
          return {
            envelope: result.envelope,
            oracle: {
              passed:
                result.stdoutContractValid &&
                result.effectPassed &&
                typeof result.envelope === "object" &&
                result.envelope !== null &&
                "final" in result.envelope &&
                (result.envelope as { final?: unknown }).final === fixture.expected,
            },
            receipt: observedReceipt(cell, currentPlan),
          };
        },
      },
    });
  } finally {
    await fs.rm(runtimeRoot, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  try {
    const options = parseCodeModeFrontierOptions(process.argv.slice(2));
    const result = await runCodeModeFrontierMatrix(options);
    console.log(
      `[code-mode-frontier] artifacts ${path.relative(options.repoRoot, result.outputDir)}`,
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    if ((error as { code?: unknown }).code === "HELP") {
      console.log(error instanceof Error ? error.message : String(error));
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href) {
  await main();
}
