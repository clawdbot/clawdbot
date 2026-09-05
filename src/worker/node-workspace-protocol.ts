import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SpawnResult } from "../process/exec.js";
import type { NodeWorkerWorkspaceTransferInput } from "./node-workspace-transfer-protocol.js";
import { hasExactOwnKeys } from "./protocol-record.js";
import {
  isWorkspaceInspectionCommand,
  WORKSPACE_INSPECTION_COMMAND,
  WORKSPACE_INSPECTION_MAX_BYTES,
} from "./workspace-inspection-protocol.js";

const IDENTIFIER_MAX_CHARS = 256;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REQUEST_MAX_BYTES = 256 * 1024;
export const NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES = 128 * 1024;
const OUTPUT_MAX_BYTES = 64 * 1024;
const STDERR_MAX_BYTES = 16 * 1024;
const ARGV_MAX_ITEMS = 128;
// Workspace scripts are shipped through this private command and remain bounded by
// REQUEST_MAX_BYTES; the canonical manifest script is larger than an ordinary argv item.
const ARG_MAX_BYTES = 128 * 1024;
const TIMEOUT_MAX_MS = 10 * 60 * 1000;
export const NODE_WORKSPACE_DRAIN_COMMAND = "openclaw-internal-workspace-drain";

export type NodeWorkerWorkspaceSeedInput =
  | { action: "apply"; key: string }
  | { action: "store"; key: string; maxAgeMs: number };

export type NodeWorkerWorkspaceExecInput = {
  gatewayNamespace: string;
  environmentId: string;
  sessionId: string;
  generation: number;
  argv: string[];
  input?: string;
  timeoutMs?: number;
  resetWorkspace?: boolean;
  transfer?: NodeWorkerWorkspaceTransferInput;
  seed?: NodeWorkerWorkspaceSeedInput;
};

export type NodeWorkerWorkspaceExecResult = SpawnResult & { workspaceDir: string };

function parseJson(raw?: string | null): unknown {
  if (!raw || Buffer.byteLength(raw, "utf8") > WORKSPACE_INSPECTION_MAX_BYTES * 2) {
    throw new Error("INVALID_REQUEST: invalid node worker workspace request");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INVALID_REQUEST: malformed node worker workspace request");
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDENTIFIER_MAX_CHARS ||
    value.trim() !== value ||
    value.includes("\0")
  ) {
    throw new Error(`INVALID_REQUEST: ${label} must be a bounded non-empty identifier`);
  }
  return value;
}

export function parseNodeWorkerWorkspaceExecInput(
  raw?: string | null,
): NodeWorkerWorkspaceExecInput {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(
      value,
      ["gatewayNamespace", "environmentId", "sessionId", "generation", "argv"],
      ["input", "timeoutMs", "resetWorkspace", "transfer", "seed"],
    )
  ) {
    throw new Error("INVALID_REQUEST: invalid node worker workspace request");
  }
  const gatewayNamespace = requireIdentifier(value.gatewayNamespace, "gatewayNamespace");
  if (!GATEWAY_NAMESPACE_PATTERN.test(gatewayNamespace)) {
    throw new Error("INVALID_REQUEST: gatewayNamespace must be a safe bounded path component");
  }
  if (
    !Number.isSafeInteger(value.generation) ||
    typeof value.generation !== "number" ||
    value.generation < 0
  ) {
    throw new Error("INVALID_REQUEST: generation must be a non-negative safe integer");
  }
  if (
    !Array.isArray(value.argv) ||
    value.argv.length === 0 ||
    value.argv.length > ARGV_MAX_ITEMS ||
    !value.argv.every(
      (arg) =>
        typeof arg === "string" &&
        arg.length > 0 &&
        !arg.includes("\0") &&
        Buffer.byteLength(arg, "utf8") <= ARG_MAX_BYTES,
    )
  ) {
    throw new Error("INVALID_REQUEST: argv must be a bounded non-empty string array");
  }
  const inspection = isWorkspaceInspectionCommand(value.argv);
  if (
    value.argv[0] === NODE_WORKSPACE_DRAIN_COMMAND &&
    (value.argv.length !== 1 ||
      value.input !== undefined ||
      value.transfer !== undefined ||
      value.seed !== undefined ||
      value.resetWorkspace !== undefined)
  ) {
    throw new Error("INVALID_REQUEST: workspace drain owns its operation");
  }
  if (
    value.argv[0] === WORKSPACE_INSPECTION_COMMAND &&
    (!inspection ||
      value.transfer !== undefined ||
      value.seed !== undefined ||
      value.resetWorkspace !== undefined)
  ) {
    throw new Error("INVALID_REQUEST: workspace inspection owns its operation");
  }
  if (!inspection && Buffer.byteLength(raw ?? "", "utf8") > REQUEST_MAX_BYTES) {
    throw new Error("INVALID_REQUEST: workspace command request exceeds its bound");
  }
  if (
    value.input !== undefined &&
    (typeof value.input !== "string" ||
      Buffer.byteLength(value.input, "utf8") >
        (inspection ? WORKSPACE_INSPECTION_MAX_BYTES : NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES))
  ) {
    throw new Error("INVALID_REQUEST: workspace command input exceeds its bound");
  }
  if (
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" ||
      !Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < 1 ||
      value.timeoutMs > TIMEOUT_MAX_MS)
  ) {
    throw new Error("INVALID_REQUEST: workspace command timeout is invalid");
  }
  if (value.resetWorkspace !== undefined && typeof value.resetWorkspace !== "boolean") {
    throw new Error("INVALID_REQUEST: resetWorkspace must be a boolean");
  }
  let seed: NodeWorkerWorkspaceSeedInput | undefined;
  if (value.seed !== undefined) {
    if (value.transfer !== undefined || value.resetWorkspace !== undefined) {
      throw new Error(
        "INVALID_REQUEST: workspace seed cannot combine with transfer or resetWorkspace",
      );
    }
    if (
      !isRecord(value.seed) ||
      typeof value.seed.key !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.seed.key)
    ) {
      throw new Error("INVALID_REQUEST: workspace seed key must be a SHA-256 hex digest");
    }
    const { action, key, maxAgeMs } = value.seed;
    if (action === "apply" && hasExactOwnKeys(value.seed, ["action", "key"])) {
      seed = { action, key };
    } else if (
      action === "store" &&
      hasExactOwnKeys(value.seed, ["action", "key", "maxAgeMs"]) &&
      typeof maxAgeMs === "number" &&
      Number.isSafeInteger(maxAgeMs) &&
      maxAgeMs >= 0
    ) {
      seed = { action, key, maxAgeMs };
    } else {
      throw new Error("INVALID_REQUEST: workspace seed action or maxAgeMs is invalid");
    }
  }
  let transfer: NodeWorkerWorkspaceTransferInput | undefined;
  if (value.transfer !== undefined) {
    if (!isRecord(value.transfer)) {
      throw new Error("INVALID_REQUEST: workspace transfer is invalid");
    }
    const direction = value.transfer.direction;
    const token = value.transfer.token;
    const manifestRef = value.transfer.manifestRef;
    const baseManifestRef = value.transfer.baseManifestRef;
    const referenceManifestRef = value.transfer.referenceManifestRef;
    const validRef = (candidate: unknown): candidate is string =>
      typeof candidate === "string" && /^sha256:[a-f0-9]{64}$/u.test(candidate);
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > 1_024 ||
      token.includes("\0") ||
      (direction === "download"
        ? !hasExactOwnKeys(
            value.transfer,
            ["direction", "token", "manifestRef"],
            ["attachments", "seedKey", "checkpointBaseManifestRef"],
          ) ||
          (value.transfer.attachments !== undefined && value.transfer.attachments !== true) ||
          (value.transfer.checkpointBaseManifestRef !== undefined &&
            (!validRef(value.transfer.checkpointBaseManifestRef) ||
              value.transfer.attachments !== undefined ||
              value.transfer.seedKey !== undefined)) ||
          (value.transfer.seedKey !== undefined &&
            (typeof value.transfer.seedKey !== "string" ||
              !/^[a-f0-9]{64}$/u.test(value.transfer.seedKey) ||
              value.transfer.attachments !== undefined))
        : direction === "upload"
          ? !hasExactOwnKeys(
              value.transfer,
              ["direction", "token", "baseManifestRef", "referenceManifestRef"],
              ["publicationBaseCommit"],
            ) ||
            (value.transfer.publicationBaseCommit !== undefined &&
              (typeof value.transfer.publicationBaseCommit !== "string" ||
                !/^[a-f0-9]{40}$/u.test(value.transfer.publicationBaseCommit)))
          : true)
    ) {
      throw new Error("INVALID_REQUEST: workspace transfer is invalid");
    }
    if (direction === "download") {
      if (!validRef(manifestRef)) {
        throw new Error("INVALID_REQUEST: workspace transfer is invalid");
      }
      transfer = {
        direction,
        token,
        manifestRef,
        ...(typeof value.transfer.seedKey === "string" ? { seedKey: value.transfer.seedKey } : {}),
        ...(value.transfer.attachments === true ? { attachments: true } : {}),
        ...(typeof value.transfer.checkpointBaseManifestRef === "string"
          ? { checkpointBaseManifestRef: value.transfer.checkpointBaseManifestRef }
          : {}),
      };
    } else {
      if (!validRef(baseManifestRef) || !validRef(referenceManifestRef)) {
        throw new Error("INVALID_REQUEST: workspace transfer is invalid");
      }
      transfer = {
        direction: "upload",
        token,
        baseManifestRef,
        referenceManifestRef,
        ...(typeof value.transfer.publicationBaseCommit === "string"
          ? { publicationBaseCommit: value.transfer.publicationBaseCommit }
          : {}),
      };
    }
  }
  return {
    gatewayNamespace,
    environmentId: requireIdentifier(value.environmentId, "environmentId"),
    sessionId: requireIdentifier(value.sessionId, "sessionId"),
    generation: value.generation,
    argv: [...value.argv],
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    ...(value.resetWorkspace === undefined ? {} : { resetWorkspace: value.resetWorkspace }),
    ...(transfer ? { transfer } : {}),
    ...(seed ? { seed } : {}),
  };
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isAbsoluteHostPath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function parseNodeWorkerWorkspaceExecResult(
  value: unknown,
  argv: readonly string[] = [],
): NodeWorkerWorkspaceExecResult | null {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(
      value,
      ["workspaceDir", "stdout", "stderr", "code", "signal", "killed", "termination"],
      [
        "stdoutTruncatedBytes",
        "stderrTruncatedBytes",
        "noOutputTimedOut",
        "outputLimitExceeded",
        "outputErrorStream",
      ],
    ) ||
    typeof value.workspaceDir !== "string" ||
    !isAbsoluteHostPath(value.workspaceDir) ||
    value.workspaceDir.length > 4_096 ||
    !isBoundedText(
      value.stdout,
      isWorkspaceInspectionCommand(argv) ? WORKSPACE_INSPECTION_MAX_BYTES : OUTPUT_MAX_BYTES,
    ) ||
    !isBoundedText(value.stderr, STDERR_MAX_BYTES) ||
    (value.code !== null &&
      (!Number.isSafeInteger(value.code) || typeof value.code !== "number")) ||
    (value.signal !== null &&
      (typeof value.signal !== "string" ||
        value.signal.length === 0 ||
        value.signal.length > 32)) ||
    typeof value.killed !== "boolean" ||
    (value.termination !== "exit" &&
      value.termination !== "timeout" &&
      value.termination !== "no-output-timeout" &&
      value.termination !== "signal")
  ) {
    return null;
  }
  for (const key of ["stdoutTruncatedBytes", "stderrTruncatedBytes"] as const) {
    const count = value[key];
    if (
      count !== undefined &&
      (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    ) {
      return null;
    }
  }
  if (
    (value.noOutputTimedOut !== undefined && typeof value.noOutputTimedOut !== "boolean") ||
    (value.outputLimitExceeded !== undefined && typeof value.outputLimitExceeded !== "boolean") ||
    (value.outputErrorStream !== undefined &&
      value.outputErrorStream !== "stdout" &&
      value.outputErrorStream !== "stderr")
  ) {
    return null;
  }
  return value as NodeWorkerWorkspaceExecResult;
}

export function projectNodeWorkerWorkspaceExecResult(
  workspaceDir: string,
  result: SpawnResult,
  argv: readonly string[] = [],
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
  const parsed = parseNodeWorkerWorkspaceExecResult(projected, argv);
  if (!parsed) {
    throw new Error("node worker workspace result violated its bounded contract");
  }
  return parsed;
}

export const NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES = OUTPUT_MAX_BYTES;
export const NODE_WORKER_WORKSPACE_STDERR_MAX_BYTES = STDERR_MAX_BYTES;
