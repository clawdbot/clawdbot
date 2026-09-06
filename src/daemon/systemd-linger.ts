/** Reads and enables systemd user linger for headless daemon sessions. */
import os from "node:os";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { execFileUtf8 } from "./exec-file.js";

function resolveLoginctlUser(env: Record<string, string | undefined>): string | null {
  const fromEnv = normalizeOptionalString(env.USER) || normalizeOptionalString(env.LOGNAME);
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

type SystemdUserLingerStatus = {
  user: string;
  linger: "yes" | "no";
};

/** Reads systemd user linger status through loginctl when available. */
export async function readSystemdUserLingerStatus(params: {
  env: Record<string, string | undefined>;
  user?: string;
}): Promise<SystemdUserLingerStatus | null> {
  const user = params.user ?? resolveLoginctlUser(params.env);
  if (!user) {
    return null;
  }
  const { stdout, code } = await execFileUtf8("loginctl", ["show-user", user, "-p", "Linger"], {
    timeout: 5_000,
  });
  const line = stdout.split("\n").find((entry) => entry.trim().startsWith("Linger="));
  const value = normalizeOptionalLowercaseString(line?.split("=")[1]);
  return code === 0 && (value === "yes" || value === "no") ? { user, linger: value } : null;
}

/** Enables systemd user linger through loginctl, with optional sudo mode. */
export async function enableSystemdUserLinger(params: {
  env: Record<string, string | undefined>;
  user?: string;
  sudoMode?: "prompt" | "non-interactive";
}): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  const user = params.user ?? resolveLoginctlUser(params.env);
  if (!user) {
    return { ok: false, stdout: "", stderr: "Missing user", code: 1 };
  }
  const needsSudo = typeof process.getuid === "function" ? process.getuid() !== 0 : true;
  // Non-root callers need sudo for loginctl, but tests and automation can force
  // non-interactive sudo to avoid hanging on password prompts.
  const sudoArgs =
    needsSudo && params.sudoMode !== undefined
      ? ["sudo", ...(params.sudoMode === "non-interactive" ? ["-n"] : [])]
      : [];
  const [command, ...args] = [...sudoArgs, "loginctl", "enable-linger", user];
  const { stdout, stderr, code } = await execFileUtf8(command, args, { timeout: 30_000 });
  return { ok: code === 0, stdout, stderr, code };
}
