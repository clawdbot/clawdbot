import { spawnSync } from "node:child_process";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type ClaudeCliAuthStatus = { status: "available" } | { status: "missing" | "unreadable" };

/** Ask Claude CLI whether its own login is usable without reading token material. */
export function probeClaudeCliAuthStatus(params?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
}): ClaudeCliAuthStatus {
  const result = spawnSync(params?.command ?? "claude", ["auth", "status", "--json"], {
    encoding: "utf8",
    env: params?.env ?? process.env,
    maxBuffer: 64 * 1024,
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.error || result.status === null) {
    return { status: "unreadable" };
  }
  if (result.status !== 0) {
    return { status: "missing" };
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isRecord(parsed) || parsed.loggedIn !== true) {
      return { status: "missing" };
    }
    return { status: "available" };
  } catch {
    return { status: "unreadable" };
  }
}
