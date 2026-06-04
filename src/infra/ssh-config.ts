// Reads effective SSH target config from the local ssh client.
import { spawn } from "node:child_process";
import { parseStrictPositiveInteger } from "./parse-finite-number.js";
import type { SshParsedTarget } from "./ssh-tunnel.js";

export const SSH_CONFIG_OUTPUT_MAX_CHARS = 64 * 1024;

export type SshResolvedConfig = {
  user?: string;
  host?: string;
  port?: number;
  identityFiles: string[];
};

type AppendSshConfigOutputResult = { ok: true; value: string } | { ok: false; reason: "too-large" };

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

export function appendSshConfigOutput(
  current: string,
  chunk: unknown,
  maxChars = SSH_CONFIG_OUTPUT_MAX_CHARS,
): AppendSshConfigOutputResult {
  const next = current + String(chunk);
  if (next.length > maxChars) {
    return { ok: false, reason: "too-large" };
  }
  return { ok: true, value: next };
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

  return await new Promise<SshResolvedConfig | null>((resolve) => {
    const child = spawn(sshPath, args, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let outputTooLarge = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      const appended = appendSshConfigOutput(stdout, chunk);
      if (!appended.ok) {
        outputTooLarge = true;
        child.kill("SIGKILL");
        return;
      }
      stdout = appended.value;
    });

    const timeoutMs = Math.max(200, opts.timeoutMs ?? 800);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } finally {
        resolve(null);
      }
    }, timeoutMs);

    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (outputTooLarge || code !== 0 || !stdout.trim()) {
        resolve(null);
        return;
      }
      resolve(parseSshConfigOutput(stdout));
    });
  });
}
