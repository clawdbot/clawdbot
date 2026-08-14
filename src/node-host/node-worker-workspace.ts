import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
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
import {
  runNodeWorkerWorkspaceTransfer,
  serializeNodeWorkerWorkspace,
} from "./node-worker-transfer-client.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const WORKSPACE_GENERATION_PRUNE_LIMIT = 256;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENVIRONMENT_HASH_PATTERN = /^[a-f0-9]{16}$/u;
const SESSION_HASH_PATTERN = /^[a-f0-9]{32}$/u;

type NodeWorkerWorkspaceLaunchReference = {
  gatewayNamespace: string;
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
};

type WorkspaceGeneration = {
  gatewayNamespace: string;
  environmentHash: string;
  sessionHash: string;
  workspacesRoot: string;
  generation: number;
  generationPath: string;
};

function hashPathComponent(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function generationKey(generation: WorkspaceGeneration): string {
  return [
    generation.gatewayNamespace,
    generation.environmentHash,
    generation.sessionHash,
    generation.generation,
  ].join("/");
}

function launchGenerationKey(reference: NodeWorkerWorkspaceLaunchReference): string {
  return [
    reference.gatewayNamespace,
    hashPathComponent(reference.environmentId, 16),
    hashPathComponent(reference.sessionId, 32),
    reference.ownerEpoch,
  ].join("/");
}

function parseGenerationName(name: string): number | undefined {
  const generation = Number(name);
  return Number.isSafeInteger(generation) && generation >= 0 && String(generation) === name
    ? generation
    : undefined;
}

async function listOwnedDirectories(parent: string): Promise<string[]> {
  try {
    return (await fsp.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function latestSessionGeneration(
  workspacesRoot: string,
  sessionHash: string,
): Promise<number | undefined> {
  let latest: number | undefined;
  for (const environmentHash of await listOwnedDirectories(workspacesRoot)) {
    if (!ENVIRONMENT_HASH_PATTERN.test(environmentHash)) {
      continue;
    }
    const sessionRoot = path.join(workspacesRoot, environmentHash, sessionHash);
    for (const name of await listOwnedDirectories(sessionRoot)) {
      const generation = parseGenerationName(name);
      if (generation !== undefined) {
        latest = Math.max(latest ?? generation, generation);
      }
    }
  }
  return latest;
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
  for (const [index, arg] of argv.entries()) {
    // Canonical workspace helpers travel as the source operand to `node -e`.
    // Treating JavaScript slash characters as host paths rejects the shipped scripts.
    if (index > 0 && argv[index - 1] === "-e" && path.basename(argv[0] ?? "") === "node") {
      continue;
    }
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

  async pruneSupersededGenerations(
    listNonterminal: () => readonly NodeWorkerWorkspaceLaunchReference[],
  ): Promise<{ deleted: number; hasMore: boolean }> {
    const generations: WorkspaceGeneration[] = [];
    const latestBySession = new Map<string, number>();
    for (const gatewayNamespace of await listOwnedDirectories(this.root)) {
      if (!GATEWAY_NAMESPACE_PATTERN.test(gatewayNamespace)) {
        continue;
      }
      const workspacesRoot = path.join(this.root, gatewayNamespace, "workspaces");
      for (const environmentHash of await listOwnedDirectories(workspacesRoot)) {
        if (!ENVIRONMENT_HASH_PATTERN.test(environmentHash)) {
          continue;
        }
        const environmentRoot = path.join(workspacesRoot, environmentHash);
        for (const sessionHash of await listOwnedDirectories(environmentRoot)) {
          if (!SESSION_HASH_PATTERN.test(sessionHash)) {
            continue;
          }
          const sessionRoot = path.join(environmentRoot, sessionHash);
          for (const generationName of await listOwnedDirectories(sessionRoot)) {
            const generation = parseGenerationName(generationName);
            if (generation === undefined) {
              continue;
            }
            generations.push({
              gatewayNamespace,
              environmentHash,
              sessionHash,
              workspacesRoot,
              generation,
              generationPath: path.join(sessionRoot, generationName),
            });
            const sessionKey = `${gatewayNamespace}/${sessionHash}`;
            latestBySession.set(
              sessionKey,
              Math.max(latestBySession.get(sessionKey) ?? generation, generation),
            );
          }
        }
      }
    }
    const initiallyProtected = new Set(listNonterminal().map(launchGenerationKey));
    const staleGenerations = generations
      .filter(
        (generation) =>
          !initiallyProtected.has(generationKey(generation)) &&
          generation.generation <
            (latestBySession.get(`${generation.gatewayNamespace}/${generation.sessionHash}`) ??
              generation.generation),
      )
      .toSorted(
        (left, right) =>
          left.generation - right.generation ||
          left.generationPath.localeCompare(right.generationPath),
      );
    const candidates = staleGenerations.slice(0, WORKSPACE_GENERATION_PRUNE_LIMIT);
    let deleted = 0;
    for (const candidate of candidates) {
      await serializeNodeWorkerWorkspace(candidate.generationPath, async () => {
        const currentLatest = await latestSessionGeneration(
          candidate.workspacesRoot,
          candidate.sessionHash,
        );
        if (currentLatest === undefined || candidate.generation >= currentLatest) {
          return;
        }
        let stats: fs.Stats;
        let sessionRoot: string;
        let generationPath: string;
        try {
          [stats, sessionRoot, generationPath] = await Promise.all([
            fsp.lstat(candidate.generationPath),
            fsp.realpath(path.dirname(candidate.generationPath)),
            fsp.realpath(candidate.generationPath),
          ]);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
          }
          throw error;
        }
        if (
          stats.isSymbolicLink() ||
          !stats.isDirectory() ||
          path.dirname(generationPath) !== sessionRoot ||
          !isPathInside(this.root, generationPath)
        ) {
          return;
        }
        // A launch can claim an older prepared generation while filesystem checks await.
        // Re-read the durable reservations immediately before removing node-owned bytes.
        if (new Set(listNonterminal().map(launchGenerationKey)).has(generationKey(candidate))) {
          return;
        }
        await fsp.rm(generationPath, { recursive: true, force: true });
        deleted += 1;
      });
    }
    return { deleted, hasMore: staleGenerations.length > candidates.length };
  }

  async exec(
    input: NodeWorkerWorkspaceExecInput,
    signal?: AbortSignal,
    gateway?: { url: string; tlsFingerprint?: string },
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
    if (input.transfer) {
      if (input.resetWorkspace) {
        throw new Error("INVALID_REQUEST: workspace transfer owns its atomic replacement");
      }
      if (!gateway?.url) {
        throw new Error("INVALID_REQUEST: workspace transfer gateway is unavailable");
      }
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
      const stdout = await runNodeWorkerWorkspaceTransfer({
        gatewayUrl: gateway.url,
        gatewayTlsFingerprint: gateway.tlsFingerprint,
        environmentId: input.environmentId,
        workspaceDir: workspacePath,
        manifestHome: sessionRoot,
        transfer: input.transfer,
        signal,
      });
      return projectWorkspaceResult(workspacePath, {
        stdout: `${stdout}\n`,
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      });
    }
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
      HOME: sessionRoot,
      ...(process.platform === "win32" ? { USERPROFILE: sessionRoot } : {}),
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
