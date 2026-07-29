// Gateway server discovery helpers.
// Provides Bonjour CLI metadata and optional Tailscale DNS hints.
import fs from "node:fs";
import path from "node:path";
import { getTailnetHostname } from "../infra/tailscale.js";
import { runExec } from "../process/exec.js";

type ResolveBonjourCliPathOptions = {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
  cwd?: string;
  statSync?: (path: string) => fs.Stats;
};

/** Formats the Bonjour instance name while preserving user-provided OpenClaw names. */
export function formatBonjourInstanceName(displayName: string) {
  const trimmed = displayName.trim();
  if (!trimmed) {
    return "OpenClaw";
  }
  if (/openclaw/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed} (OpenClaw)`;
}

/** Resolves the CLI path advertised to Bonjour clients, preferring explicit env config. */
export function resolveBonjourCliPath(opts: ResolveBonjourCliPathOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  const envPath = env.OPENCLAW_CLI_PATH?.trim();
  if (envPath) {
    return envPath;
  }

  const statSync = opts.statSync ?? fs.statSync;
  const isFile = (candidate: string) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  const execPath = opts.execPath ?? process.execPath;
  const execDir = path.dirname(execPath);
  const siblingCli = path.join(execDir, "openclaw");
  if (isFile(siblingCli)) {
    return siblingCli;
  }

  const argv = opts.argv ?? process.argv;
  const argvPath = argv[1];
  if (argvPath && isFile(argvPath)) {
    return argvPath;
  }

  const cwd = opts.cwd ?? process.cwd();
  const distCli = path.join(cwd, "dist", "index.js");
  if (isFile(distCli)) {
    return distCli;
  }
  const binCli = path.join(cwd, "bin", "openclaw");
  if (isFile(binCli)) {
    return binCli;
  }

  return undefined;
}

/** Resolves a Tailnet DNS hint from env or the local tailscale CLI when enabled. */
export async function resolveTailnetDnsHint(opts?: {
  env?: NodeJS.ProcessEnv;
  exec?: typeof runExec;
  enabled?: boolean;
}): Promise<string | undefined> {
  const env = opts?.env ?? process.env;
  const envRaw = env.OPENCLAW_TAILNET_DNS?.trim();
  const envValue = envRaw && envRaw.length > 0 ? envRaw.replace(/\.$/, "") : "";
  if (envValue) {
    return envValue;
  }
  if (opts?.enabled === false) {
    return undefined;
  }

  const exec =
    opts?.exec ??
    ((command, args) => runExec(command, args, { timeoutMs: 1500, maxBuffer: 200_000 }));
  try {
    return await getTailnetHostname(exec);
  } catch {
    return undefined;
  }
}
