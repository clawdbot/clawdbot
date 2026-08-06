// Builds platform shell argv for Node-driven command execution.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

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
