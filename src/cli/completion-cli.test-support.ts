import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Command } from "commander";
import { expect, it, type TestAPI } from "vitest";
import { getCompletionScript, registerCompletionCli } from "./completion-cli.js";
import { quoteCliArg } from "./quote-cli-arg.js";

export function createCompletionProgram(): Command {
  const program = new Command();
  program.name("openclaw");
  program.description("CLI root");
  program.option("-v, --verbose", "Verbose output");
  program.option(
    "--status-json",
    "Output JSON (alias for `models status --json`) in $OPENCLAW_STATE_DIR",
  );

  const gateway = program.command("gateway").description("Gateway commands");
  gateway.option("--force", "Force the action");
  gateway.option("-t, --token <token>", "Gateway token");

  gateway.command("status").description("Show gateway status").option("--json", "JSON output");
  gateway.command("restart").description("Restart gateway");
  program
    .command("agent")
    .description("Agent commands")
    .option("--verbose <on|off>", "Set verbosity");
  const sessions = program.command("sessions").description("Session commands");
  sessions.option("--verbose", "Verbose output");
  sessions.command("cleanup").description("Clean sessions").option("--dry-run", "Preview cleanup");

  return program;
}

export function createDocumentedCompletionProgram(): Command {
  const program = createCompletionProgram();
  registerCompletionCli(program);
  return program;
}

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

export function runGeneratedBashCompletion(
  program: Command,
  words: readonly string[],
  input: {
    line?: string;
    word?: string;
    point?: number;
    cword?: number;
    bashPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string[] {
  const script = getCompletionScript("bash", program);
  const result = spawnSync(
    input.bashPath ?? "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `${script}
COMP_WORDS=(${words.map(quoteCliArg).join(" ")})
COMP_CWORD=${input.cword ?? words.length - 1}
COMP_LINE=${quoteCliArg(input.line ?? words.join(" "))}
COMP_POINT=${input.point ?? "${#COMP_LINE}"}
_openclaw_completion openclaw ${quoteCliArg(input.word ?? words.at(-1) ?? "")}
printf '%s\\n' "\${COMPREPLY[@]}"
`,
    ],
    { encoding: "utf8", env: input.env },
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
export const itWithFish: TestAPI["skip"] = fishPath ? it : it.skip;

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
export const itWithPowerShell: TestAPI["skip"] = powerShellPath ? it : it.skip;

type PowerShellCompletionResponse =
  | { version: 1; id: string; ok: true; completions: string[] }
  | { version: 1; id: string; ok: false; error: string };

type PendingPowerShellCompletion = {
  reject: (error: Error) => void;
  resolve: (completions: string[]) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const POWERSHELL_CASE_TIMEOUT_MS = 15_000;
const POWERSHELL_CLOSE_TIMEOUT_MS = 5_000;

function encodePowerShellHostScript(framePrefix: string): string {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('${framePrefix}READY')
[Console]::Out.Flush()
while (($encodedRequest = [Console]::In.ReadLine()) -ne $null) {
  $request = $null
  try {
    $requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedRequest))
    $request = $requestJson | ConvertFrom-Json
    $completionScript = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$request.script))
    $commandLine = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$request.commandLine))
    Register-ArgumentCompleter -Native -CommandName openclaw -ScriptBlock $null
    Invoke-Expression $completionScript | Out-Null
    $completions = @(
      [System.Management.Automation.CommandCompletion]::CompleteInput(
        $commandLine,
        $commandLine.Length,
        $null
      ).CompletionMatches | ForEach-Object { [string]$_.CompletionText }
    )
    $response = @{ version = 1; id = [string]$request.id; ok = $true; completions = $completions }
  } catch {
    $responseId = if ($null -ne $request -and $null -ne $request.id) {
      [string]$request.id
    } else {
      'unknown'
    }
    $response = @{ version = 1; id = $responseId; ok = $false; error = ($_ | Out-String).Trim() }
  } finally {
    Register-ArgumentCompleter -Native -CommandName openclaw -ScriptBlock $null
  }
  $responseJson = $response | ConvertTo-Json -Compress -Depth 5
  $encodedResponse = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($responseJson))
  [Console]::Out.WriteLine('${framePrefix}' + $encodedResponse)
  [Console]::Out.Flush()
}
`;
  return Buffer.from(script, "utf16le").toString("base64");
}

function decodePowerShellCompletionResponse(encoded: string): PowerShellCompletionResponse {
  const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PowerShell completion response was not an object");
  }
  const response = value as Record<string, unknown>;
  if (
    response.version !== 1 ||
    typeof response.id !== "string" ||
    typeof response.ok !== "boolean"
  ) {
    throw new Error("PowerShell completion response had an invalid envelope");
  }
  if (response.ok) {
    if (
      !Array.isArray(response.completions) ||
      !response.completions.every((completion) => typeof completion === "string")
    ) {
      throw new Error("PowerShell completion response had invalid completions");
    }
    return {
      version: 1,
      id: response.id,
      ok: true,
      completions: response.completions,
    };
  }
  if (typeof response.error !== "string") {
    throw new Error("PowerShell completion response had no error text");
  }
  return { version: 1, id: response.id, ok: false, error: response.error };
}

/** One live PowerShell process per test file; cases remain sequential and state-isolated. */
export class PowerShellCompletionRunner {
  private child: ChildProcessWithoutNullStreams | undefined;
  private closing = false;
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  private failure: Error | undefined;
  private readonly framePrefix = `OPENCLAW_PWSH_V1:${randomBytes(8).toString("hex")}:`;
  private pending = new Map<string, PendingPowerShellCompletion>();
  private queue: Promise<void> = Promise.resolve();
  private readyPromise: Promise<void> | undefined;
  private stdoutLines: ReadlineInterface | undefined;

  complete(program: Command, commandLine: string): Promise<string[]> {
    const script = getCompletionScript("powershell", program);
    const caseId = createHash("sha256")
      .update(script)
      .update("\0")
      .update(commandLine)
      .digest("hex")
      .slice(0, 20);
    const result = this.queue.then(() => this.completeCase(caseId, script, commandLine));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    await this.queue;
    if (!this.child || !this.exitPromise) {
      return;
    }
    this.closing = true;
    this.child.stdin.end();
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        this.exitPromise,
        new Promise<never>((_resolve, reject) => {
          closeTimer = setTimeout(
            () => reject(new Error("PowerShell completion runner did not exit after stdin closed")),
            POWERSHELL_CLOSE_TIMEOUT_MS,
          );
        }),
      ]);
      if (outcome.code !== 0 || outcome.signal !== null) {
        throw new Error(
          `PowerShell completion runner exited with code ${String(outcome.code)} signal ${String(outcome.signal)}`,
        );
      }
      if (this.failure) {
        throw this.failure;
      }
    } catch (error) {
      this.child.kill("SIGTERM");
      setTimeout(() => this.child?.kill("SIGKILL"), 1_000).unref();
      throw error;
    } finally {
      if (closeTimer) {
        clearTimeout(closeTimer);
      }
      this.stdoutLines?.close();
    }
  }

  private async completeCase(
    caseId: string,
    script: string,
    commandLine: string,
  ): Promise<string[]> {
    await this.start();
    if (this.failure) {
      throw this.failure;
    }
    const child = this.child;
    if (!child) {
      throw new Error("PowerShell completion runner did not start");
    }
    const request = Buffer.from(
      JSON.stringify({
        version: 1,
        id: caseId,
        script: Buffer.from(script, "utf8").toString("base64"),
        commandLine: Buffer.from(commandLine, "utf8").toString("base64"),
      }),
      "utf8",
    ).toString("base64");
    return await new Promise<string[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.poison(new Error(`PowerShell completion case ${caseId} timed out`));
      }, POWERSHELL_CASE_TIMEOUT_MS);
      this.pending.set(caseId, { reject, resolve, timeout });
      child.stdin.write(`${request}\n`, (error) => {
        if (error) {
          this.poison(new Error(`PowerShell completion write failed: ${error.message}`));
        }
      });
    });
  }

  private start(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }
    if (!powerShellPath) {
      return Promise.reject(new Error("PowerShell is unavailable"));
    }
    const child = spawn(
      powerShellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodePowerShellHostScript(this.framePrefix),
      ],
      { stdio: "pipe" },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    this.stdoutLines = createInterface({ input: child.stdout });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        const error = new Error("PowerShell completion runner did not become ready");
        reject(error);
        this.poison(error);
      }, POWERSHELL_CASE_TIMEOUT_MS);
      this.stdoutLines?.on("line", (line) => {
        if (line === `${this.framePrefix}READY`) {
          clearTimeout(readyTimeout);
          resolve();
          return;
        }
        if (!line.startsWith(this.framePrefix)) {
          this.poison(new Error(`Unexpected PowerShell completion stdout: ${line}`));
          return;
        }
        try {
          const response = decodePowerShellCompletionResponse(line.slice(this.framePrefix.length));
          const pending = this.pending.get(response.id);
          if (!pending) {
            this.poison(new Error(`Unexpected PowerShell completion response id: ${response.id}`));
            return;
          }
          clearTimeout(pending.timeout);
          this.pending.delete(response.id);
          if (response.ok) {
            pending.resolve(response.completions);
          } else {
            pending.reject(
              new Error(`PowerShell completion case ${response.id} failed: ${response.error}`),
            );
          }
        } catch (error) {
          this.poison(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.once("error", (error) => {
        reject(error);
        this.poison(error);
      });
      child.stderr.on("data", (chunk: string) => {
        const stderr = chunk.trim();
        if (stderr) {
          this.poison(new Error(`Unexpected PowerShell completion stderr: ${stderr}`));
        }
      });
      this.exitPromise = new Promise((exitResolve) => {
        child.once("exit", (code, signal) => {
          clearTimeout(readyTimeout);
          exitResolve({ code, signal });
          if (!this.closing || code !== 0 || signal !== null) {
            this.poison(
              new Error(
                `PowerShell completion runner exited unexpectedly with code ${String(code)} signal ${String(signal)}`,
              ),
            );
          }
        });
      });
    });
    return this.readyPromise;
  }

  private poison(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing) {
      this.child?.kill("SIGTERM");
    }
  }
}
