import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { takeWorkspaceHashMemo } from "../gateway/worker-environments/workspace-hash-memo.js";
import { parseWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  NODE_WORKER_WORKSPACE_STDERR_MAX_BYTES,
  NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES,
  projectNodeWorkerWorkspaceExecResult,
  type NodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecResult,
} from "../worker/node-workspace-protocol.js";
import { buildSkillResourceCommand } from "../worker/skill-resource-receiver.js";
import { isWorkspaceInspectionCommand } from "../worker/workspace-inspection-protocol.js";
import { inspectSessionWorkspace } from "../worker/workspace-inspection.js";
import type {
  NodeWorkerPreparedWorkspaceStore,
  NodeWorkerPreparedWorkspaceRow,
} from "./node-worker-prepared-workspace-store.js";
import {
  runNodeWorkerWorkspaceTransfer,
  type NodeWorkerTransferGateway,
} from "./node-worker-transfer-client.js";
import { captureManifest } from "./node-worker-workspace-commands.js";
import {
  assertWorkspaceArgv,
  ensureContainedDirectory as ensureNodeWorkerWorkspaceDirectory,
} from "./node-worker-workspace-identity.js";
import { runNodeWorkerWorkspaceSeed } from "./node-worker-workspace-seeds.js";

const DEFAULT_TIMEOUT_MS = 120_000;

export async function removeIfEmpty(target: string): Promise<void> {
  try {
    await fsp.rmdir(target);
  } catch (error) {
    if (
      !hasErrnoCode(error, "ENOENT") &&
      !hasErrnoCode(error, "ENOTEMPTY") &&
      !hasErrnoCode(error, "EEXIST")
    ) {
      throw error;
    }
  }
}

export async function removeNodeWorkerWorkspaceDirectory(
  root: string,
  target: string,
  canDelete: () => boolean = () => true,
): Promise<boolean> {
  try {
    const [stats, parent, resolved] = await Promise.all([
      fsp.lstat(target),
      fsp.realpath(path.dirname(target)),
      fsp.realpath(target),
    ]);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      path.dirname(resolved) !== parent ||
      !isPathInside(root, resolved)
    ) {
      return false;
    }
    if (!canDelete()) {
      return false;
    }
    await fsp.rm(target, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function execNodeWorkerWorkspace(params: {
  input: NodeWorkerWorkspaceExecInput;
  root: string;
  sessionRoot: string;
  workspacePath: string;
  generationKey: string;
  seedsRoot: string;
  env: NodeJS.ProcessEnv;
  workspaceHashMemos: Map<string, Map<string, string>>;
  latestTransferredManifest: Map<string, string>;
  prepared?: { row: NodeWorkerPreparedWorkspaceRow; store: NodeWorkerPreparedWorkspaceStore };
  signal?: AbortSignal;
  gateway?: NodeWorkerTransferGateway;
}): Promise<NodeWorkerWorkspaceExecResult> {
  const { input, sessionRoot, workspacePath, generationKey, signal, gateway } = params;
  const workspaceName = path.basename(workspacePath);
  const homeDir = params.prepared?.row.home_dir ?? sessionRoot;
  if (params.prepared && (input.resetWorkspace !== undefined || input.seed)) {
    throw new Error("INVALID_REQUEST: a consumed prepared workspace cannot be reset or reseeded");
  }
  if (
    input.transfer ||
    input.resetWorkspace ||
    input.seed ||
    input.capture ||
    input.skillResources
  ) {
    try {
      const stats = fs.lstatSync(workspacePath);
      const resolved = fs.realpathSync.native(workspacePath);
      if (stats.isSymbolicLink() || !stats.isDirectory() || !isPathInside(sessionRoot, resolved)) {
        throw new Error("INVALID_REQUEST: node worker workspace path escaped its owner root");
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  if (input.capture) {
    const base = parseWorkerWorkspaceManifest(
      await fsp.readFile(
        path.join(
          homeDir,
          ".openclaw-worker",
          "manifests",
          `${input.capture.baseManifestRef.slice(7)}.json`,
        ),
        "utf8",
      ),
      input.capture.baseManifestRef,
    );
    const captured = await captureManifest({
      workspaceDir: workspacePath,
      manifestHome: homeDir,
      baseCommit: base.baseCommit,
      ...input.capture,
      hashMemo: takeWorkspaceHashMemo(params.workspaceHashMemos, generationKey),
      signal,
    });
    return projectNodeWorkerWorkspaceExecResult(workspacePath, {
      stdout: JSON.stringify(captured),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
  }
  if (input.seed) {
    if (input.seed.action === "apply") {
      await removeNodeWorkerWorkspaceDirectory(params.root, workspacePath);
      ensureNodeWorkerWorkspaceDirectory(sessionRoot, workspaceName);
    }
    const stdout = await runNodeWorkerWorkspaceSeed({
      seedsRoot: params.seedsRoot,
      gatewayNamespace: input.gatewayNamespace,
      workspaceDir: workspacePath,
      seed: input.seed,
      signal,
    });
    return projectNodeWorkerWorkspaceExecResult(workspacePath, {
      stdout: `${stdout}\n`,
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
  }
  if (input.transfer) {
    if (input.resetWorkspace) {
      throw new Error("INVALID_REQUEST: workspace transfer owns its atomic replacement");
    }
    if (!gateway?.url) {
      throw new Error("INVALID_REQUEST: workspace transfer gateway is unavailable");
    }
    const hashMemo = takeWorkspaceHashMemo(params.workspaceHashMemos, generationKey);
    const stdout = await runNodeWorkerWorkspaceTransfer({
      seedsRoot: params.seedsRoot,
      gatewayNamespace: input.gatewayNamespace,
      gatewayUrl: gateway.url,
      gatewayTlsFingerprint: gateway.tlsFingerprint,
      gatewayCloudflareAccess: gateway.cloudflareAccess,
      environmentId: input.environmentId,
      workspaceDir: workspacePath,
      manifestHome: homeDir,
      transfer: input.transfer,
      hashMemo,
      prepared: params.prepared,
      signal,
    });
    // A snapshot sent before this transfer knows only the old base. Keep the latest
    // result across command gaps; supersede it on transfer or drop it with its generation.
    if (
      !(input.transfer.direction === "download" && input.transfer.attachments) &&
      !(input.transfer.direction === "upload" && input.transfer.publicationBaseCommit)
    ) {
      params.latestTransferredManifest.set(generationKey, stdout);
    }
    return projectNodeWorkerWorkspaceExecResult(workspacePath, {
      stdout: `${stdout}\n`,
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
  }
  if (isWorkspaceInspectionCommand(input.argv)) {
    const stat = fs.lstatSync(workspacePath, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("INVALID_REQUEST: workspace inspection root is unavailable");
    }
    const workspaceDir = fs.realpathSync.native(workspacePath);
    if (!isPathInside(sessionRoot, workspaceDir)) {
      throw new Error("INVALID_REQUEST: workspace inspection root is unavailable");
    }
    const stdout = await inspectSessionWorkspace(workspaceDir, input.input, () =>
      signal?.throwIfAborted(),
    );
    return projectNodeWorkerWorkspaceExecResult(
      workspaceDir,
      {
        stdout,
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      },
      input.argv,
    );
  }
  if (input.resetWorkspace) {
    // Reset never accepts a caller path: only the identity-derived workspace can be removed.
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
  const workspaceDir = params.prepared
    ? workspacePath
    : ensureNodeWorkerWorkspaceDirectory(sessionRoot, workspaceName);
  // Resource artifacts belong to this generation outside the project tree. Only the
  // typed operation may derive that sibling path; ordinary argv stays workspace-bound.
  const argv = input.skillResources
    ? buildSkillResourceCommand({
        parentDir: sessionRoot,
        generation: input.generation,
        operation: input.skillResources,
      })
    : input.argv;
  if (!input.skillResources) {
    assertWorkspaceArgv(workspaceDir, argv);
  }
  const commandEnv = {
    ...params.env,
    HOME: homeDir,
    ...(process.platform === "win32" ? { USERPROFILE: homeDir } : {}),
  };
  const result = await runCommandWithTimeout(argv, {
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
  return projectNodeWorkerWorkspaceExecResult(workspaceDir, result);
}
