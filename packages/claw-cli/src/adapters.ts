import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";
import type { LocalClawPackage } from "./types.js";

const MAX_ADAPTER_OUTPUT_BYTES = 4 * 1024 * 1024;

export type HarnessPreview = {
  id: string;
  outcome: unknown;
};

type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type AdapterRuntime = {
  run(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd?: string,
  ): Promise<ProcessResult>;
};

function appendBounded(chunks: Buffer[], chunk: Buffer, currentBytes: number): number {
  const nextBytes = currentBytes + chunk.byteLength;
  if (nextBytes > MAX_ADAPTER_OUTPUT_BYTES) {
    throw new CliError({
      code: "adapter_output_too_large",
      phase: "adapter",
      message: `Harness output exceeds ${MAX_ADAPTER_OUTPUT_BYTES} bytes.`,
    });
  }
  chunks.push(chunk);
  return nextBytes;
}

const defaultRuntime: AdapterRuntime = {
  run(command, args, env, cwd) {
    return new Promise((resolveResult, reject) => {
      const child = spawn(command, args, {
        env,
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminalError: unknown;
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          stdoutBytes = appendBounded(stdout, chunk, stdoutBytes);
        } catch (error) {
          terminalError = error;
          child.kill();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        try {
          stderrBytes = appendBounded(stderr, chunk, stderrBytes);
        } catch (error) {
          terminalError = error;
          child.kill();
        }
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (terminalError) {
          reject(terminalError);
          return;
        }
        resolveResult({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  },
};

async function resolveOpenClawInvocation(): Promise<{
  command: string;
  prefix: string[];
  cwd?: string;
}> {
  const configured = process.env.OPENCLAW_CLI_ENTRY?.trim();
  const incubationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const developmentRunner = resolve(incubationRoot, "scripts", "run-node.mjs");
  const repositoryEntry = resolve(incubationRoot, "openclaw.mjs");
  if (configured) {
    const entry = resolve(configured);
    return { command: process.execPath, prefix: [entry], cwd: dirname(entry) };
  }
  if (
    await access(developmentRunner)
      .then(() => true)
      .catch(() => false)
  ) {
    return { command: process.execPath, prefix: [developmentRunner], cwd: incubationRoot };
  }
  if (
    await access(repositoryEntry)
      .then(() => true)
      .catch(() => false)
  ) {
    return { command: process.execPath, prefix: [repositoryEntry], cwd: incubationRoot };
  }
  if (process.platform === "win32") {
    throw new CliError({
      code: "openclaw_entry_required",
      phase: "adapter",
      message:
        "Set OPENCLAW_CLI_ENTRY to the installed openclaw.mjs path during Windows incubation.",
      path: "openclaw",
    });
  }
  return { command: "openclaw", prefix: [] };
}

export async function previewWithHarness(
  harness: string,
  claw: LocalClawPackage,
  runtime: AdapterRuntime = defaultRuntime,
): Promise<HarnessPreview> {
  if (harness !== "openclaw") {
    throw new CliError({
      code: "unknown_adapter",
      phase: "adapter",
      message: `Unknown agent harness adapter: ${harness}.`,
      path: harness,
    });
  }
  if (claw.summary.hasPortablePrompt) {
    throw new CliError({
      code: "openclaw_portable_prompt_unsupported",
      phase: "adapter",
      message:
        "This OpenClaw adapter cannot preview a CLAW.md body until OpenClaw maps it to SOUL.md.",
      path: "CLAW.md",
    });
  }
  const invocation = await resolveOpenClawInvocation();
  const snapshotRoot = await mkdtemp(join(tmpdir(), "claws-preview-"));
  let result: ProcessResult;
  try {
    for (const file of claw.payload) {
      const target = resolve(snapshotRoot, ...file.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes, { flag: "wx" });
    }
    result = await runtime.run(
      invocation.command,
      [...invocation.prefix, "claws", "add", snapshotRoot, "--dry-run", "--json"],
      { ...process.env, OPENCLAW_EXPERIMENTAL_CLAWS: "1" },
      invocation.cwd,
    );
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError({
      code: "adapter_launch_failed",
      phase: "adapter",
      message: `Could not launch OpenClaw: ${error instanceof Error ? error.message : String(error)}`,
      path: "openclaw",
    });
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
  let outcome: unknown;
  try {
    outcome = JSON.parse(result.stdout);
  } catch {
    throw new CliError({
      code: "invalid_adapter_output",
      phase: "adapter",
      message: "OpenClaw did not return one valid JSON outcome.",
      path: "openclaw",
    });
  }
  if (result.exitCode !== 0) {
    throw new CliError(
      {
        code: "adapter_preview_failed",
        phase: "adapter",
        message: "OpenClaw rejected the dry-run preview.",
        path: "openclaw",
      },
      { harness: { id: "openclaw", outcome } },
    );
  }
  return { id: "openclaw", outcome };
}
