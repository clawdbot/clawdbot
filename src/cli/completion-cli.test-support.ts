import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { expect, it } from "vitest";
import { getCompletionScript } from "./completion-cli.js";
import { quoteCliArg } from "./quote-cli-arg.js";

export function createAliasedCompletionProgram(): Command {
  const program = new Command();
  program.name("openclaw");
  program.option("--profile <name>", "Profile");
  const infer = program.command("infer").alias("capability").description("Run inference");
  infer.command("embed").description("Embed text").option("--model <id>", "Model id");
  const cron = program.command("cron").description("Cron commands");
  cron
    .command("add")
    .alias("create")
    .description("Add a job")
    .option("--at <time>", "Schedule time");
  return program;
}

export function runGeneratedBashCompletion(program: Command, words: readonly string[]): string[] {
  const script = getCompletionScript("bash", program);
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `${script}
COMP_WORDS=(${words.map(quoteCliArg).join(" ")})
COMP_CWORD=${words.length - 1}
_openclaw_completion
printf '%s\\n' "\${COMPREPLY[@]}"
`,
    ],
    { encoding: "utf8" },
  );

  if (result.error) {
    throw result.error;
  }
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout.split("\n").filter(Boolean);
}

function findFish(): string | null {
  const executable = process.platform === "win32" ? "fish.exe" : "fish";
  const candidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, executable));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const fishPath = findFish();
export const itWithFish = fishPath ? it : it.skip;

export function runGeneratedFishCompletion(program: Command, commandLine: string): string[] {
  if (!fishPath) {
    throw new Error("Fish is unavailable");
  }

  const script = getCompletionScript("fish", program);
  const quotedCommandLine = commandLine.replaceAll("'", "\\'");
  const result = spawnSync(
    fishPath,
    ["--no-config", "--command", `${script}\ncomplete --do-complete '${quotedCommandLine}'`],
    { encoding: "utf8", timeout: 15_000 },
  );

  if (result.error) {
    throw result.error;
  }
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((completion) => completion.split("\t")[0] ?? completion);
}

function findPowerShell(): string | null {
  const executable = process.platform === "win32" ? "pwsh.exe" : "pwsh";
  const candidates = [
    process.env.OPENCLAW_TEST_PWSH,
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, executable)),
  ];
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(candidate && existsSync(candidate)),
    ) ?? null
  );
}

const powerShellPath = findPowerShell();
export const itWithPowerShell = powerShellPath ? it : it.skip;

export function runGeneratedPowerShellCompletion(program: Command, commandLine: string): string[] {
  if (!powerShellPath) {
    throw new Error("PowerShell is unavailable");
  }

  const script = getCompletionScript("powershell", program);
  const quotedCommandLine = commandLine.replaceAll("'", "''");
  const result = spawnSync(
    powerShellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `${script}
$line = '${quotedCommandLine}'
[System.Management.Automation.CommandCompletion]::CompleteInput($line, $line.Length, $null).CompletionMatches | ForEach-Object { $_.CompletionText }
`,
    ],
    { encoding: "utf8" },
  );

  if (result.error) {
    throw result.error;
  }
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}
