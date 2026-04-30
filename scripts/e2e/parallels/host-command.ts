import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandResult, RunOptions } from "./types.ts";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function say(message: string): void {
  process.stdout.write(`==> ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`warn: ${message}\n`);
}

export function die(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function run(command: string, args: string[], options: RunOptions = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    input: options.input,
    maxBuffer: 50 * 1024 * 1024,
    stdio: options.quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs,
  });

  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (result.error && !(timedOut && options.check === false)) {
    throw result.error;
  }

  const status = timedOut ? 124 : (result.status ?? (result.signal ? 128 : 1));
  const commandResult = {
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
    status,
  };
  if (options.check !== false && status !== 0) {
    if (commandResult.stdout) {
      process.stdout.write(commandResult.stdout);
    }
    if (commandResult.stderr) {
      process.stderr.write(commandResult.stderr);
    }
    die(`command failed (${status}): ${[command, ...args].join(" ")}`);
  }
  return commandResult;
}

export function sh(script: string, options: RunOptions = {}): CommandResult {
  return run("bash", ["-lc", script], options);
}

export async function runStreaming(
  command: string,
  args: string[],
  options: RunOptions & { logPath?: string } = {},
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    } satisfies SpawnOptions);

    let log = "";
    const append = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      log += text;
      if (!options.quiet) {
        process.stdout.write(text);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      log += text;
      if (!options.quiet) {
        process.stderr.write(text);
      }
    });
    if (options.input != null) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }

    let timedOut = false;
    const timer =
      options.timeoutMs == null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
          }, options.timeoutMs);

    child.on("error", reject);
    child.on("close", async (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (options.logPath) {
        await writeFile(options.logPath, log, "utf8");
      }
      if (timedOut) {
        resolve(124);
      } else {
        resolve(code ?? (signal ? 128 : 1));
      }
    });
  });
}
