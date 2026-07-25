#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { previewWithHarness } from "./adapters.js";
import { CliError } from "./errors.js";
import { inspectLocalPackage } from "./source.js";
import {
  INCUBATION_STABILITY,
  OUTCOME_SCHEMA_VERSION,
  type CliOutcome,
  type FailureOutcome,
  type LocalClawPackage,
  type SuccessOutcome,
} from "./types.js";

const usage = `Standalone Claw CLI incubator

Usage:
  claws-dev inspect <local-package> [--json]
  claws-dev <local-package> --agent openclaw --dry-run [--json]

Set OPENCLAW_EXPERIMENTAL_CLAWS=1 to enable this private command.`;

type Io = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

type Dependencies = {
  inspect(source: string): Promise<LocalClawPackage>;
  preview(harness: string, claw: LocalClawPackage): Promise<{ id: string; outcome: unknown }>;
};

const defaultDependencies: Dependencies = {
  inspect: inspectLocalPackage,
  preview: previewWithHarness,
};

function isExperimentalEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.OPENCLAW_EXPERIMENTAL_CLAWS?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function failure(operation: "inspect" | "preview", error: unknown): FailureOutcome {
  const diagnostics =
    error instanceof CliError
      ? error.diagnostics
      : [
          {
            code: "internal_error",
            phase: "source" as const,
            message: error instanceof Error ? error.message : String(error),
          },
        ];
  return {
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    stability: INCUBATION_STABILITY,
    operation,
    ok: false,
    ...(error instanceof CliError && error.harness ? { harness: error.harness } : {}),
    diagnostics,
  };
}

function success(
  operation: "inspect" | "preview",
  claw: LocalClawPackage,
  harness?: { id: string; outcome: unknown },
): SuccessOutcome {
  return {
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    stability: INCUBATION_STABILITY,
    operation,
    ok: true,
    package: claw.source,
    claw: claw.summary,
    ...(harness ? { harness } : {}),
    diagnostics: [],
  };
}

function renderHuman(outcome: CliOutcome): string {
  if (!outcome.ok) {
    return outcome.diagnostics
      .map((entry) => `${entry.code}: ${entry.message}${entry.path ? ` (${entry.path})` : ""}`)
      .join("\n");
  }
  return [
    `${outcome.claw.agent.name ?? outcome.claw.agent.id} (${outcome.package.packageName}@${outcome.package.packageVersion})`,
    `agent: ${outcome.claw.agent.id}`,
    `portable prompt: ${outcome.claw.hasPortablePrompt ? "yes" : "no"}`,
    `integrity: ${outcome.package.integrity}`,
    ...(outcome.harness ? [`harness preview: ${outcome.harness.id}`] : []),
  ].join("\n");
}

export async function runCli(
  argv: string[],
  options: {
    io?: Io;
    env?: NodeJS.ProcessEnv;
    dependencies?: Dependencies;
  } = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const env = options.env ?? process.env;
  const dependencies = options.dependencies ?? defaultDependencies;
  const inspectCommand = argv[0] === "inspect";
  const operation = inspectCommand ? "inspect" : "preview";
  const args = inspectCommand ? argv.slice(1) : argv;

  if (!isExperimentalEnabled(env)) {
    const outcome = failure(
      operation,
      new CliError({
        code: "experimental_claws_disabled",
        phase: "arguments",
        message:
          "Standalone Claws are experimental. Set OPENCLAW_EXPERIMENTAL_CLAWS=1 for this process.",
      }),
    );
    io.stderr.write(
      `${argv.includes("--json") ? JSON.stringify(outcome, null, 2) : renderHuman(outcome)}\n`,
    );
    return 2;
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        agent: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    const outcome = failure(
      operation,
      new CliError({
        code: "invalid_arguments",
        phase: "arguments",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    io.stderr.write(
      `${argv.includes("--json") ? JSON.stringify(outcome, null, 2) : renderHuman(outcome)}\n`,
    );
    return 2;
  }

  let outcome: CliOutcome;
  try {
    const source = parsed.positionals[0];
    if (!source || parsed.positionals.length !== 1) {
      throw new CliError({
        code: "invalid_arguments",
        phase: "arguments",
        message: "Provide exactly one local Claw package directory.",
      });
    }
    const claw = await dependencies.inspect(source);
    if (inspectCommand) {
      if (parsed.values.agent !== undefined || parsed.values["dry-run"] === true) {
        throw new CliError({
          code: "invalid_arguments",
          phase: "arguments",
          message: "inspect does not accept --agent or --dry-run.",
        });
      }
      outcome = success("inspect", claw);
    } else {
      const harness = parsed.values.agent;
      if (typeof harness !== "string" || harness.length === 0) {
        throw new CliError({
          code: "missing_adapter",
          phase: "arguments",
          message: "Preview requires --agent <harness>.",
        });
      }
      if (parsed.values["dry-run"] !== true) {
        throw new CliError({
          code: "dry_run_required",
          phase: "arguments",
          message: "The incubation CLI supports harness delegation only with --dry-run.",
        });
      }
      outcome = success("preview", claw, await dependencies.preview(harness, claw));
    }
  } catch (error) {
    outcome = failure(operation, error);
  }

  const output = parsed.values.json ? JSON.stringify(outcome, null, 2) : renderHuman(outcome);
  (outcome.ok ? io.stdout : io.stderr).write(`${output}\n`);
  return outcome.ok ? 0 : outcome.diagnostics[0]?.phase === "adapter" ? 3 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length <= 2) {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = await runCli(process.argv.slice(2));
  }
}
