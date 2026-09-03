import { spawnSync } from "node:child_process";
import { CODEX_APP_SERVER_AUTH_MARKER } from "openclaw/plugin-sdk/agent-runtime";

type CodexNativeAuthMode = "api-key" | "oauth" | "token";

/** Ask Codex for login status without reading its credential storage. */
export function resolveCodexNativeAuth(
  params: {
    command?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const result = spawnSync(params.command ?? "codex", ["login", "status"], {
    encoding: "utf8",
    env: { ...process.env, ...params.env },
    maxBuffer: 16 * 1024,
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  const status = [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
  const loggedInLine = status.split("\n").find((line) => line.startsWith("Logged in using "));
  if (!loggedInLine) {
    return undefined;
  }
  const mode: CodexNativeAuthMode = loggedInLine.includes("API key")
    ? "api-key"
    : loggedInLine.includes("access token") || loggedInLine.includes("personal access token")
      ? "token"
      : "oauth";
  return {
    apiKey: CODEX_APP_SERVER_AUTH_MARKER,
    source: "Codex CLI native auth",
    mode,
  };
}
