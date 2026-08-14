import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isPathInside } from "../infra/path-guards.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  NODE_WORKER_WORKSPACE_STDERR_MAX_BYTES,
  NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES,
  parseNodeWorkerWorkspaceExecResult,
  type NodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecResult,
} from "../worker/node-workspace-protocol.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";

const DEFAULT_TIMEOUT_MS = 120_000;

function hashPathComponent(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function ensureContainedDirectory(parent: string, name: string): string {
  const candidate = path.join(parent, name);
  fs.mkdirSync(candidate, { recursive: true });
  const stats = fs.lstatSync(candidate);
  const resolved = fs.realpathSync.native(candidate);
  if (stats.isSymbolicLink() || !stats.isDirectory() || !isPathInside(parent, resolved)) {
    throw new Error("INVALID_REQUEST: node worker workspace path escaped its owner root");
  }
  return resolved;
}

function resolveArgumentPath(workspaceDir: string, arg: string): string | undefined {
  if (path.isAbsolute(arg)) {
    return arg;
  }
  if (arg.startsWith(".") || arg.includes("/") || (path.sep === "\\" && arg.includes("\\"))) {
    return path.resolve(workspaceDir, arg);
  }
  return undefined;
}

function assertWorkspaceArgv(workspaceDir: string, argv: readonly string[]): void {
  // This private transport owns cwd and direct path operands; it is not the user-facing
  // system.run policy domain, so absolute/relative escapes must never cross its workspace.
  for (const arg of argv) {
    const candidate = resolveArgumentPath(workspaceDir, arg);
    if (!candidate) {
      continue;
    }
    let resolved = candidate;
    try {
      resolved = fs.realpathSync.native(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (resolved !== workspaceDir && !isPathInside(workspaceDir, resolved)) {
      throw new Error("INVALID_REQUEST: workspace command argv resolves outside its workspace");
    }
  }
}

function projectWorkspaceResult(
  workspaceDir: string,
  result: Awaited<ReturnType<typeof runCommandWithTimeout>>,
): NodeWorkerWorkspaceExecResult {
  const projected = {
    workspaceDir,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    signal: result.signal,
    killed: result.killed,
    termination: result.termination,
    ...(result.stdoutTruncatedBytes === undefined
      ? {}
      : { stdoutTruncatedBytes: result.stdoutTruncatedBytes }),
    ...(result.stderrTruncatedBytes === undefined
      ? {}
      : { stderrTruncatedBytes: result.stderrTruncatedBytes }),
    ...(result.noOutputTimedOut === undefined ? {} : { noOutputTimedOut: result.noOutputTimedOut }),
    ...(result.outputLimitExceeded === undefined
      ? {}
      : { outputLimitExceeded: result.outputLimitExceeded }),
    ...(result.outputErrorStream === undefined
      ? {}
      : { outputErrorStream: result.outputErrorStream }),
  };
  const parsed = parseNodeWorkerWorkspaceExecResult(projected);
  if (!parsed) {
    throw new Error("node worker workspace result violated its bounded contract");
  }
  return parsed;
}

/** Runs trusted worker transport commands only from a node-owned session workspace. */
export class NodeWorkerWorkspaceRuntime {
  private readonly root: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: { root?: string; env?: NodeJS.ProcessEnv } = {}) {
    const env = options.env ?? process.env;
    const configuredRoot = path.resolve(
      options.root ?? path.join(resolveStateDir(env), "node-host"),
    );
    fs.mkdirSync(configuredRoot, { recursive: true });
    this.root = fs.realpathSync.native(configuredRoot);
    this.env = {
      ...snapshotNodeWorkerEnv(env),
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: "",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS: "",
    };
  }

  async exec(
    input: NodeWorkerWorkspaceExecInput,
    signal?: AbortSignal,
  ): Promise<NodeWorkerWorkspaceExecResult> {
    const gatewayRoot = ensureContainedDirectory(this.root, input.gatewayNamespace);
    const workspacesRoot = ensureContainedDirectory(gatewayRoot, "workspaces");
    const environmentRoot = ensureContainedDirectory(
      workspacesRoot,
      hashPathComponent(input.environmentId, 16),
    );
    const sessionRoot = ensureContainedDirectory(
      environmentRoot,
      hashPathComponent(input.sessionId, 32),
    );
    const workspaceName = String(input.generation);
    const workspacePath = path.join(sessionRoot, workspaceName);
    if (input.resetWorkspace) {
      try {
        const stats = fs.lstatSync(workspacePath);
        const resolved = fs.realpathSync.native(workspacePath);
        if (
          stats.isSymbolicLink() ||
          !stats.isDirectory() ||
          !isPathInside(sessionRoot, resolved)
        ) {
          throw new Error("INVALID_REQUEST: node worker workspace path escaped its owner root");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      // Reset never accepts a caller path: only the identity-derived workspace can be removed.
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
    const workspaceDir = ensureContainedDirectory(sessionRoot, workspaceName);
    assertWorkspaceArgv(workspaceDir, input.argv);
    const commandEnv = {
      ...this.env,
      HOME: workspaceDir,
      ...(process.platform === "win32" ? { USERPROFILE: workspaceDir } : {}),
    };
    const result = await runCommandWithTimeout(input.argv, {
      cwd: workspaceDir,
      baseEnv: commandEnv,
      ...(input.input === undefined ? {} : { input: input.input }),
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
      killProcessTree: true,
      maxOutputBytes: {
        stdout: NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES,
        stderr: NODE_WORKER_WORKSPACE_STDERR_MAX_BYTES,
      },
      terminateOnOutputLimit: true,
    });
    return projectWorkspaceResult(workspaceDir, result);
  }
}
