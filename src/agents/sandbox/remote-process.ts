/** Owns executor-side descendants independently of the local transport process. */
import { randomUUID } from "node:crypto";
import type { SandboxBackendHandle } from "./backend-handle.types.js";

const SANDBOX_EXEC_MARKER = "OPENCLAW_SANDBOX_EXEC_ID";
const SANDBOX_REMOTE_REAP_TIMEOUT_MS = 4_500;

export function prepareSandboxRemoteProcess(
  backend: SandboxBackendHandle,
  env: Record<string, string>,
): { env: Record<string, string>; terminate: () => Promise<void> } {
  const marker = randomUUID();
  return {
    env: { ...env, [SANDBOX_EXEC_MARKER]: marker },
    terminate: async () => {
      const result = await backend.runShellCommand({
        script: SANDBOX_REMOTE_TERMINATE_SCRIPT,
        args: [`${SANDBOX_EXEC_MARKER}=${marker}`],
        allowFailure: true,
        signal: AbortSignal.timeout(SANDBOX_REMOTE_REAP_TIMEOUT_MS),
      });
      if (result.code !== 0) {
        const detail =
          result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
        throw new Error(
          detail ||
            `Sandbox process tree cleanup failed with code ${result.code}; tear down the sandbox environment and inspect surviving processes before retrying.`,
        );
      }
    },
  };
}

const SANDBOX_REMOTE_TERMINATE_SCRIPT = String.raw`
find_owned_pids() {
  for env_file in /proc/[0-9]*/environ; do
    if [ -r "$env_file" ] && tr '\0' '\n' < "$env_file" 2>/dev/null | grep -Fqx "$1"; then
      basename "$(dirname "$env_file")"
    fi
  done
}
owned="$(find_owned_pids "$1")"
[ -z "$owned" ] || kill -TERM $owned 2>/dev/null || true
sleep 1
owned="$(find_owned_pids "$1")"
[ -z "$owned" ] || kill -KILL $owned 2>/dev/null || true
sleep 1
owned="$(find_owned_pids "$1")"
[ -z "$owned" ] || { echo "Sandbox process IDs survived SIGKILL: $owned" >&2; exit 1; }
`.trim();
