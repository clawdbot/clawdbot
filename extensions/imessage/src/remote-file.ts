// Stages gateway-local outbound files into a private directory on the Messages Mac.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeScpRemoteHost } from "openclaw/plugin-sdk/host-runtime";
import {
  type CommandOptions,
  runCommandWithTimeout,
  type SpawnResult,
} from "openclaw/plugin-sdk/process-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { sanitizeTempFileName } from "openclaw/plugin-sdk/temp-path";

const TOKEN_PATTERN = /^[a-f0-9]{32}$/u;
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
] as const;
const CLEANUP_TIMEOUT_MS = 10_000;
const log = createSubsystemLogger("channels/imessage");

type RunCommand = (argv: string[], options: CommandOptions) => Promise<SpawnResult>;

type RemoteFileDeps = {
  runCommand?: RunCommand;
  createToken?: () => string;
  onCleanupError?: (error: Error) => void;
};

function commandError(label: string, result: SpawnResult): Error | undefined {
  if (result.code === 0 && result.termination === "exit") {
    return undefined;
  }
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(
    `${label} failed (${result.termination}${result.code === null ? "" : `, code ${result.code}`})${detail ? `: ${detail}` : ""}`,
  );
}

async function runChecked(
  run: RunCommand,
  label: string,
  argv: string[],
  options: CommandOptions,
): Promise<SpawnResult> {
  const result = await run(argv, {
    killProcessTree: true,
    maxOutputBytes: { stdout: 4 * 1024, stderr: 64 * 1024 },
    outputCapture: { stdout: "head", stderr: "tail" },
    ...options,
  });
  const error = commandError(label, result);
  if (error) {
    throw error;
  }
  return result;
}

function requireToken(createToken: () => string): string {
  const token = createToken().replaceAll("-", "").toLowerCase();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("iMessage remote staging generated an invalid temporary token");
  }
  return token;
}

export async function withIMessageRemoteFile<T>(params: {
  remoteHost: string;
  localPath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  deps?: RemoteFileDeps;
  use: (remotePath: string) => Promise<T>;
}): Promise<T> {
  const remoteHost = normalizeScpRemoteHost(params.remoteHost);
  if (!remoteHost) {
    throw new Error("invalid iMessage remoteHost for SSH/SCP staging");
  }
  const run = params.deps?.runCommand ?? runCommandWithTimeout;
  const token = requireToken(params.deps?.createToken ?? randomUUID);
  const remoteDir = `/tmp/openclaw-imessage-${token}`;
  const remotePath = `${remoteDir}/${sanitizeTempFileName(path.basename(params.localPath))}`;
  const createScript = `set -eu
umask 077
directory=${remoteDir}
trap 'rm -rf -- "$directory"' EXIT HUP INT TERM
mkdir -m 700 -- "$directory"
trap - EXIT HUP INT TERM
`;
  const cleanupScript = `set -eu
rm -rf -- ${remoteDir}
`;

  try {
    await runChecked(
      run,
      "iMessage remote temporary directory allocation",
      ["ssh", ...SSH_OPTIONS, "-T", "--", remoteHost, "sh -s"],
      { input: createScript, timeoutMs: params.timeoutMs, signal: params.signal },
    );
    await runChecked(
      run,
      "iMessage remote file upload",
      ["scp", ...SSH_OPTIONS, "--", params.localPath, `${remoteHost}:${remotePath}`],
      { timeoutMs: params.timeoutMs, signal: params.signal },
    );
    return await params.use(remotePath);
  } finally {
    try {
      // An aborted caller may still own a remote file, so cleanup gets its own
      // bounded attempt without reusing the already-aborted signal.
      await runChecked(
        run,
        "iMessage remote file cleanup",
        ["ssh", ...SSH_OPTIONS, "-T", "--", remoteHost, "sh -s"],
        { input: cleanupScript, timeoutMs: CLEANUP_TIMEOUT_MS },
      );
    } catch (cleanupError) {
      (
        params.deps?.onCleanupError ??
        ((error) => log.warn(`remote attachment cleanup failed: ${error.message}`))
      )(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
    }
  }
}
