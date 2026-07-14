import path from "node:path";
import process from "node:process";
import { execa, type Options as ExecaOptions, type ResultPromise } from "execa";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import { resolveSafeChildProcessInvocation } from "./windows-command.js";

export const COMMAND_PROCESS_TREE_KILL_GRACE_MS = 300;

function assignChildEnvValue(params: {
  env: NodeJS.ProcessEnv;
  key: string;
  platform: NodeJS.Platform;
  value: string | undefined;
}): void {
  if (params.value === undefined) {
    return;
  }
  if (params.platform === "win32") {
    const normalizedKey = params.key.toLowerCase();
    for (const existingKey of Object.keys(params.env)) {
      if (existingKey.toLowerCase() === normalizedKey && existingKey !== params.key) {
        delete params.env[existingKey];
      }
    }
  }
  params.env[params.key] = params.value;
}

function mergeChildEnv(params: {
  baseEnv: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const resolvedEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(params.baseEnv)) {
    assignChildEnvValue({ env: resolvedEnv, key, platform: params.platform, value });
  }
  for (const [key, value] of Object.entries(params.env ?? {})) {
    assignChildEnvValue({ env: resolvedEnv, key, platform: params.platform, value });
  }
  return resolvedEnv;
}

export function shouldSpawnWithShell(params: {
  resolvedCommand: string;
  platform: NodeJS.Platform;
}): boolean {
  // SECURITY: never enable `shell` for argv-based execution.
  // `shell` routes through cmd.exe on Windows, which turns untrusted argv values
  // (like chat prompts passed as CLI args) into command-injection primitives.
  // If you need a shell, use an explicit shell-wrapper argv (e.g. `cmd.exe /c ...`)
  // and validate/escape at the call site.
  void params;
  return false;
}

export type SpawnCommandOptions = Omit<
  ExecaOptions,
  "env" | "extendEnv" | "shell" | "windowsHide" | "windowsVerbatimArguments"
> & {
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
};

export function spawnCommandWithInvocation<
  OptionsType extends SpawnCommandOptions = SpawnCommandOptions,
>(
  argv: string[],
  options: OptionsType = {} as OptionsType,
): {
  child: ResultPromise<OptionsType>;
  invocation: ReturnType<typeof resolveSafeChildProcessInvocation>;
} {
  const { baseEnv, env, windowsVerbatimArguments, ...execaOptions } = options;
  const commandEnv = resolveCommandEnv({ argv, baseEnv, env });
  const invocation = resolveSafeChildProcessInvocation({
    argv,
    cwd: execaOptions.cwd,
    env: commandEnv,
    windowsVerbatimArguments,
  });
  const child = execa(invocation.command, invocation.args, {
    ...execaOptions,
    env: commandEnv,
    extendEnv: false,
    shell: false,
    windowsHide: invocation.windowsHide,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  }) as unknown as ResultPromise<OptionsType>;
  return { child, invocation };
}

/** Spawn through the canonical argv, environment, and Windows safety boundary. */
export function spawnCommand<OptionsType extends SpawnCommandOptions = SpawnCommandOptions>(
  argv: string[],
  options: OptionsType = {} as OptionsType,
): ResultPromise<OptionsType> {
  return spawnCommandWithInvocation(argv, options).child;
}

export function resolveCommandEnv(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const baseEnv = params.baseEnv ?? process.env;
  const platform = params.platform ?? process.platform;
  const argv = params.argv;
  const shouldSuppressNpmFund = (() => {
    const cmd = path.basename(argv[0] ?? "");
    if (cmd === "npm" || cmd === "npm.cmd" || cmd === "npm.exe") {
      return true;
    }
    if (cmd === "node" || cmd === "node.exe") {
      const script = argv[1] ?? "";
      return script.includes("npm-cli.js");
    }
    return false;
  })();

  const resolvedEnv = mergeChildEnv({ baseEnv, env: params.env, platform });
  if (shouldSuppressNpmFund) {
    if (resolvedEnv.NPM_CONFIG_FUND == null) {
      resolvedEnv.NPM_CONFIG_FUND = "false";
    }
    if (resolvedEnv.npm_config_fund == null) {
      resolvedEnv.npm_config_fund = "false";
    }
  }
  return markOpenClawExecEnv(resolvedEnv);
}
