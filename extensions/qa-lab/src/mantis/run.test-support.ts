// Qa Lab test support builds Mantis command results and lane summaries.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";

export function requireArgAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0) {
    throw new Error(`expected ${flag} argument`);
  }
  return expectDefined(args[index + 1], `${flag} argument value`);
}

export type StubCommandResult = {
  code: number | null;
  killed: boolean;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  stdoutTruncatedBytes?: number;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
};

export function successfulCommandResult(stdout = ""): StubCommandResult {
  return { code: 0, killed: false, signal: null, stderr: "", stdout, termination: "exit" };
}

export function failedCommandResult(code = 1): StubCommandResult {
  return { code, killed: false, signal: null, stderr: "", stdout: "", termination: "exit" };
}

export function worktreeListOutput(worktreeDir: string): string {
  return `worktree ${worktreeDir}\0HEAD 0000000000000000000000000000000000000000\0detached\0\0`;
}

export function timedOutCommandResult(): StubCommandResult {
  return {
    code: 124,
    killed: true,
    signal: "SIGTERM",
    stderr: "",
    stdout: "",
    termination: "timeout",
  };
}

export async function findSingleMantisGenerationErrorPath(outputDir: string): Promise<string> {
  const generationsDir = path.join(outputDir, ".mantis-generations");
  const generationEntries = await fs.readdir(generationsDir, { withFileTypes: true });
  const errorPaths = (
    await Promise.all(
      generationEntries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map(async (entry) => {
          const errorPath = path.join(generationsDir, entry.name, "error.txt");
          try {
            const stat = await fs.lstat(errorPath);
            return stat.isFile() ? errorPath : undefined;
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              return undefined;
            }
            throw error;
          }
        }),
    )
  ).filter((errorPath): errorPath is string => errorPath !== undefined);
  if (errorPaths.length !== 1) {
    throw new Error(`expected exactly one Mantis generation error, found ${errorPaths.length}`);
  }
  return expectDefined(errorPaths[0], "Mantis generation error path");
}

export async function writeLegacyLaneSummary(params: {
  args: readonly string[];
  scenario: string;
}) {
  const repoRootArg = requireArgAfter(params.args, "--repo-root");
  const outputDirArg = requireArgAfter(params.args, "--output-dir");
  const lane = outputDirArg.endsWith("baseline") ? "baseline" : "candidate";
  const outputDir = path.join(repoRootArg, outputDirArg);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "discord-qa-summary.json"),
    `${JSON.stringify(
      { scenarios: [{ id: params.scenario, status: lane === "baseline" ? "fail" : "pass" }] },
      null,
      2,
    )}\n`,
  );
}
