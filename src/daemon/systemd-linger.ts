import os from "node:os";
import { formatErrorMessage } from "../infra/errors.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

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

export async function readSystemdUserLingerStatus(
  env: Record<string, string | undefined>,
): Promise<SystemdUserLingerStatus | null> {
  const user = resolveLoginctlUser(env);
  if (!user) {
    return null;
  }
  try {
    const { stdout } = await runExec("loginctl", ["show-user", user, "-p", "Linger"], {
      timeoutMs: 5_000,
    });
    const line = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("Linger="));
    const value = normalizeOptionalLowercaseString(line?.split("=")[1]);
    if (value === "yes" || value === "no") {
      return { user, linger: value };
    }
  } catch {
    // ignore; loginctl may be unavailable
  }
  return null;
}

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
  const sudoArgs =
    needsSudo && params.sudoMode !== undefined
      ? ["sudo", ...(params.sudoMode === "non-interactive" ? ["-n"] : [])]
      : [];
  const argv = [...sudoArgs, "loginctl", "enable-linger", user];
  try {
    const result = await runCommandWithTimeout(argv, { timeoutMs: 30_000 });
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code ?? 1,
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    return { ok: false, stdout: "", stderr: message, code: 1 };
  }
}
