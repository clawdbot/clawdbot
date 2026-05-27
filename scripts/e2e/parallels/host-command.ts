import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNpmRunner } from "../../npm-runner.mjs";
import { resolvePnpmRunner } from "../../pnpm-runner.mjs";
import { buildCmdExeCommandLine } from "../../windows-cmd-helpers.mjs";
import type { CommandResult, RunOptions } from "./types.ts";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type HostCommandInvocation = {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
};

type ResolveHostCommandOptions = {
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsSync?: (path: string) => boolean;
  platform?: NodeJS.Platform;
};

function hostInvocationFromRunner(runner: HostCommandInvocation): HostCommandInvocation {
  if (runner.env === undefined) {
    const invocation = { ...runner };
    delete invocation.env;
    return invocation;
  }
  return runner;
}

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

function portableBasename(value: string): string {
  return value.split(/[/\\]/u).at(-1) ?? value;
}

function portableExtension(value: string): string {
  return path.posix.extname(portableBasename(value)).toLowerCase();
}

function isBareCommand(command: string, name: "npm" | "pnpm"): boolean {
  return portableBasename(command) === command && command.toLowerCase() === name;
}

function resolveEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

export function resolveHostCommandInvocation(
  command: string,
  args: string[],
  options: ResolveHostCommandOptions = {},
): HostCommandInvocation {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const comSpec = options.comSpec ?? resolveEnvValue(env, "ComSpec") ?? "cmd.exe";

  if (isBareCommand(command, "pnpm")) {
    const runner = resolvePnpmRunner({
      comSpec,
      npmExecPath: env.npm_execpath,
      nodeExecPath: options.execPath ?? process.execPath,
      platform,
      pnpmArgs: args,
    });
    return hostInvocationFromRunner(runner);
  }

  if (isBareCommand(command, "npm")) {
    const runner = resolveNpmRunner({
      comSpec,
      env,
      execPath: options.execPath ?? process.execPath,
      existsSync: options.existsSync,
      npmArgs: args,
      platform,
    });
    return hostInvocationFromRunner(runner);
  }

  const extension = portableExtension(command);
  if (platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    return {
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(command, args)],
      command: comSpec,
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  return { args, command, shell: false };
}

export function run(command: string, args: string[], options: RunOptions = {}): CommandResult {
  const env = { ...process.env, ...options.env };
  const invocation = resolveHostCommandInvocation(command, args, { env });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: invocation.env ?? env,
    input: options.input,
    killSignal: "SIGKILL",
    maxBuffer: 50 * 1024 * 1024,
    stdio: options.quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    shell: invocation.shell,
    timeout: options.timeoutMs,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
    const env = { ...process.env, ...options.env };
    const invocation = resolveHostCommandInvocation(command, args, { env });
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd ?? repoRoot,
      env: invocation.env ?? env,
      shell: invocation.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
