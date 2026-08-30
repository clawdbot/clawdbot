// Local subprocess-backed remote bridge fixtures shared by focused sandbox tests.
import { spawnSync } from "node:child_process";
import { SANDBOX_CREATE_EXISTS_EXIT_CODE } from "./fs-bridge-mutation-helper.js";
import type { RemoteShellSandboxHandle } from "./remote-fs-bridge.types.js";

export type LocalRemoteShellSpawnResult = {
  stdout: string | Buffer | null;
  stderr: string | Buffer | null;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export type LocalRemoteShellSpawn = (
  file: string,
  args: string[],
  stdin?: string | Buffer,
) => LocalRemoteShellSpawnResult;

const PINNED_MUTATION_MARKER = 'python3 /dev/fd/3 "$@" 3<<';

function spawnLocalRemoteShell(file: string, args: string[], stdin?: string | Buffer) {
  return spawnSync(file, args, {
    input: stdin,
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function createLocalRemoteShellScriptRunner(params?: {
  spawn?: LocalRemoteShellSpawn;
  onCommand?: (command: Parameters<RemoteShellSandboxHandle["runRemoteShellScript"]>[0]) => void;
  shellArg0?: string;
}): RemoteShellSandboxHandle["runRemoteShellScript"] {
  return async (command) => {
    params?.onCommand?.(command);
    const runsPinnedMutation = command.script.includes(PINNED_MUTATION_MARKER);
    const spawn = params?.spawn ?? spawnLocalRemoteShell;
    // Linux integration executes the remote command unchanged, including its
    // fd 3 heredoc, while stdin remains available for mutation payloads.
    const result = spawn(
      "/bin/sh",
      ["-c", command.script, params?.shellArg0 ?? "openclaw-sandbox-fs", ...(command.args ?? [])],
      command.stdin,
    );
    const stdout = Buffer.isBuffer(result.stdout)
      ? result.stdout
      : Buffer.from(result.stdout ?? []);
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr
      : Buffer.from(result.stderr ?? []);
    const code = result.status ?? (result.signal ? 128 : 1);
    // A pinned exclusive create may exit before consuming stdin. Preserve its
    // reserved collision status; every other spawn failure remains fatal.
    const expectedCreatePipeClose =
      runsPinnedMutation &&
      command.args?.[0] === "create" &&
      command.allowFailure === true &&
      result.status === SANDBOX_CREATE_EXISTS_EXIT_CODE &&
      result.signal === null &&
      result.error &&
      "code" in result.error &&
      result.error.code === "EPIPE";
    if (result.error && !expectedCreatePipeClose) {
      throw result.error;
    }
    if (code !== 0 && !command.allowFailure) {
      throw Object.assign(
        new Error(stderr.toString("utf8").trim() || `shell exited with code ${code}`),
        { code, stdout, stderr },
      );
    }
    return { stdout, stderr, code };
  };
}
