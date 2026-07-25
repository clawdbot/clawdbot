// Reads effective SSH target config from the local ssh client.
import { runCommandWithTimeout } from "../process/exec.js";
import { parseStrictPositiveInteger } from "./parse-finite-number.js";
import type { SshParsedTarget } from "./ssh-tunnel.js";

export const SSH_CONFIG_OUTPUT_MAX_CHARS = 64 * 1024;

export type SshResolvedConfig = {
  user?: string;
  host?: string;
  port?: number;
  identityFiles: string[];
};

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined || parsed > 65535) {
    return undefined;
  }
  return parsed;
}

export function parseSshConfigOutput(output: string): SshResolvedConfig {
  const result: SshResolvedConfig = { identityFiles: [] };
  const lines = output.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    const value = rest.join(" ").trim();
    if (!key || !value) {
      continue;
    }
    switch (key) {
      case "user":
        result.user = value;
        break;
      case "hostname":
        result.host = value;
        break;
      case "port":
        result.port = parsePort(value);
        break;
      case "identityfile":
        if (value !== "none") {
          result.identityFiles.push(value);
        }
        break;
      default:
        break;
    }
  }
  return result;
}

export async function resolveSshConfig(
  target: SshParsedTarget,
  opts: { identity?: string; timeoutMs?: number } = {},
): Promise<SshResolvedConfig | null> {
  const sshPath = "/usr/bin/ssh";
  const args = ["-G"];
  if (target.port > 0 && target.port !== 22) {
    args.push("-p", String(target.port));
  }
  if (opts.identity?.trim()) {
    args.push("-i", opts.identity.trim());
  }
  const userHost = target.user ? `${target.user}@${target.host}` : target.host;
  // Use "--" so userHost can't be parsed as an ssh option.
  args.push("--", userHost);

  try {
    const result = await runCommandWithTimeout([sshPath, ...args], {
      maxOutputBytes: SSH_CONFIG_OUTPUT_MAX_CHARS,
      outputCapture: "head",
      terminateOnOutputLimit: true,
      timeoutMs: Math.max(200, opts.timeoutMs ?? 800),
    });
    if (result.code !== 0 || result.termination !== "exit" || !result.stdout.trim()) {
      return null;
    }
    return parseSshConfigOutput(result.stdout);
  } catch {
    return null;
  }
}
