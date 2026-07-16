import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";

// Claude's npm shim can remain executable after its postinstall failed. Prefer
// the operator's login-shell command, then carry that PATH into the PTY.
export function resolveClaudeTerminalExecutable(env: NodeJS.ProcessEnv = process.env) {
  return resolveNodeHostExecutable("claude", {
    env,
    pathEnv: env.PATH ?? env.Path ?? "",
    strategy: "prefer",
  });
}
