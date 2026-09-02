// Builds platform shell argv for Node-driven command execution.
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  LOGIN_SHELL_PATH_CARRIER_ENV,
  prependCarrierPathToShellPayload,
} from "./login-shell-path-carrier.js";

// Node shell command construction keeps platform shell flags centralized for
// system.run and related command execution paths.
/** Build argv for running a command through the platform default shell. */
export function buildNodeShellCommand(command: string, platform?: string | null) {
  const normalized = normalizeLowercaseStringOrEmpty((platform ?? "").trim());
  if (normalized.startsWith("win")) {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  if (normalized === "darwin" || normalized.startsWith("macos")) {
    // The Mac node binds static allowlisted commands through non-login sh.
    // A login shell can execute unapproved startup files before the payload.
    return ["/bin/sh", "-c", command];
  }
  return ["/bin/sh", "-lc", command];
}

const POSIX_SHELL_BASENAMES = new Set(["sh", "bash", "dash", "zsh"]);

// Deliberately narrower than `shell-inline-command.ts`: only the plain
// `<shell> [-l/-c flags] <payload>` form `buildNodeShellCommand` emits. Other
// shapes (`--login`, `-o <name>`, trailing operands) keep today's behavior
// rather than risk mistaking a flag for the payload and running the wrong one.
function isPosixLoginShellPayloadArgv(argv: readonly string[]): boolean {
  const shell = argv[0]?.trim();
  if (argv.length < 3 || !shell) {
    return false;
  }
  if (!POSIX_SHELL_BASENAMES.has(normalizeLowercaseStringOrEmpty(path.posix.basename(shell)))) {
    return false;
  }
  const flags = argv.slice(1, -1);
  return (
    flags.every((flag) => /^-[lc]+$/.test(flag)) &&
    flags.some((flag) => flag.includes("l")) &&
    flags.some((flag) => flag.includes("c"))
  );
}

/** Re-apply the sanitized node execution PATH after a login shell sources its profile. */
export function restoreLoginShellServicePath(
  argv: string[],
  env: Record<string, string> | undefined,
): { argv: string[]; env: Record<string, string> | undefined } {
  const servicePath = env?.PATH;
  if (!servicePath || !isPosixLoginShellPayloadArgv(argv)) {
    return { argv, env };
  }
  return {
    argv: [...argv.slice(0, -1), prependCarrierPathToShellPayload(argv[argv.length - 1] ?? "")],
    // Assigned last so a request-scoped override of the carrier cannot win.
    env: { ...env, [LOGIN_SHELL_PATH_CARRIER_ENV]: servicePath },
  };
}
