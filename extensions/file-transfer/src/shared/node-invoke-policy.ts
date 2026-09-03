// File Transfer plugin module implements node invoke policy behavior.
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { projectBoundedTextTail } from "./append-bounded-text-tail.js";
import { appendFileTransferAudit, type FileTransferAuditOp } from "./audit.js";
import { commandKind, requestApproval } from "./node-invoke-policy-approval.js";
import {
  FILE_TRANSFER_NODE_INVOKE_COMMANDS,
  type FileTransferNodeInvokeCommand,
} from "./node-invoke-policy-commands.js";
import { prepareParams, validateFetchMaxBytesParam } from "./node-invoke-policy-params.js";
import {
  DIR_FETCH_MAX_ENTRIES,
  policyDeniedResult,
  runDirFetchPreflight,
  runPathPreflight,
  validateCanonicalAuthorization,
  validateDirFetchEntries,
} from "./node-invoke-policy-preflight.js";
import type { PathBinding } from "./path-binding.js";
import { persistLiteralGrant } from "./policy.js";
const DIR_FETCH_ARCHIVE_LIST_TIMEOUT_MS = 30_000;
const DIR_FETCH_ARCHIVE_LIST_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DIR_FETCH_ARCHIVE_LIST_STDERR_TAIL_CHARS = 4096;
const DIR_FETCH_ARCHIVE_LIST_ERROR_STDERR_CHARS = 200;

type FileTransferCommand = FileTransferNodeInvokeCommand;

function readPath(params: Record<string, unknown>): string {
  return typeof params.path === "string" ? params.path : "";
}

function readResultPayload(result: { payload?: unknown }): Record<string, unknown> | null {
  return result.payload && typeof result.payload === "object" && !Array.isArray(result.payload)
    ? (result.payload as Record<string, unknown>)
    : null;
}

function readAuditSizeBytes(
  command: FileTransferCommand,
  payload: Record<string, unknown> | null,
  verifiedDirFetchBytes?: number,
): number | undefined {
  if (command === "dir.fetch") {
    return verifiedDirFetchBytes;
  }
  if (command === "dir.list") {
    return undefined;
  }
  return typeof payload?.size === "number" ? payload.size : undefined;
}

function normalizeTarEntryPath(entry: string): string | null {
  const normalized = entry.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  return normalized.length > 0 ? normalized : null;
}

async function listDirFetchArchiveEntries(
  payload: Record<string, unknown> | null,
): Promise<
  | { ok: true; entries: string[]; sizeBytes: number; sha256: string }
  | { ok: false; code: string; reason: string }
> {
  const tarBase64 = typeof payload?.tarBase64 === "string" ? payload.tarBase64 : "";
  if (!tarBase64) {
    return {
      ok: false,
      code: "ARCHIVE_ENTRIES_MISSING",
      reason: "dir.fetch archive did not return tarBase64",
    };
  }
  const tarBuffer = Buffer.from(tarBase64, "base64");
  const sizeBytes = tarBuffer.byteLength;
  if (typeof payload?.tarBytes === "number" && payload.tarBytes !== sizeBytes) {
    return {
      ok: false,
      code: "ARCHIVE_SIZE_MISMATCH",
      reason: `dir.fetch archive size mismatch: payload says ${payload.tarBytes} bytes, decoded ${sizeBytes}`,
    };
  }
  const sha256 = crypto.createHash("sha256").update(tarBuffer).digest("hex");
  if (typeof payload?.sha256 === "string" && payload.sha256.toLowerCase() !== sha256) {
    return {
      ok: false,
      code: "ARCHIVE_INTEGRITY_FAILURE",
      reason: `dir.fetch archive sha256 mismatch: payload says ${payload.sha256.toLowerCase()}, decoded ${sha256}`,
    };
  }
  const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
  const entries: string[] = [];
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let outputBytes = 0;
  let outputTooLarge = false;
  let entriesTooMany = false;
  const appendLine = (line: string): boolean => {
    const entry = normalizeTarEntryPath(line);
    if (entry === null) {
      return true;
    }
    entries.push(entry);
    entriesTooMany = entries.length > DIR_FETCH_MAX_ENTRIES;
    return !entriesTooMany;
  };
  const result = await runCommandWithTimeout([tarBin, "-tzf", "-"], {
    input: tarBuffer,
    maxOutputBytes: { stderr: DIR_FETCH_ARCHIVE_LIST_STDERR_TAIL_CHARS },
    onOutputChunk: (chunk, stream) => {
      if (stream !== "stdout") {
        return true;
      }
      outputBytes += chunk.byteLength;
      if (outputBytes > DIR_FETCH_ARCHIVE_LIST_MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        return false;
      }
      const lines = `${pending}${decoder.write(chunk)}`.split("\n");
      pending = lines.pop() ?? "";
      return lines.every(appendLine);
    },
    outputCapture: { stdout: "discard", stderr: "tail" },
    tolerateOutputError: { stderr: true },
    timeoutMs: DIR_FETCH_ARCHIVE_LIST_TIMEOUT_MS,
  }).catch((error: unknown) => ({ error }));
  if (!("termination" in result)) {
    return {
      ok: false,
      code: "ARCHIVE_ENTRIES_UNREADABLE",
      reason: `tar -tzf error: ${formatErrorMessage(result.error)}`,
    };
  }
  if (result.termination === "timeout") {
    return { ok: false, code: "ARCHIVE_ENTRIES_UNREADABLE", reason: "tar -tzf timed out" };
  }
  if (entriesTooMany) {
    return {
      ok: false,
      code: "ARCHIVE_ENTRIES_TOO_MANY",
      reason: `dir.fetch archive contains more than ${DIR_FETCH_MAX_ENTRIES} entries`,
    };
  }
  if (outputTooLarge) {
    return {
      ok: false,
      code: "ARCHIVE_ENTRIES_UNREADABLE",
      reason: "tar -tzf output too large",
    };
  }
  if (result.termination !== "exit") {
    return {
      ok: false,
      code: "ARCHIVE_ENTRIES_UNREADABLE",
      reason: `tar -tzf error: ${result.termination}`,
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      code: "ARCHIVE_ENTRIES_UNREADABLE",
      reason: `tar -tzf exited ${result.code}: ${projectBoundedTextTail(result.stderr, DIR_FETCH_ARCHIVE_LIST_ERROR_STDERR_CHARS)}`,
    };
  }
  appendLine(pending + decoder.end());
  if (entries.length > DIR_FETCH_MAX_ENTRIES) {
    return {
      ok: false,
      code: "ARCHIVE_ENTRIES_TOO_MANY",
      reason: `dir.fetch archive contains more than ${DIR_FETCH_MAX_ENTRIES} entries`,
    };
  }
  return { ok: true, entries, sizeBytes, sha256 };
}

async function handleFileTransferInvoke(
  ctx: OpenClawPluginNodeInvokePolicyContext,
): Promise<OpenClawPluginNodeInvokePolicyResult> {
  if (!FILE_TRANSFER_NODE_INVOKE_COMMANDS.includes(ctx.command as FileTransferCommand)) {
    return { ok: false, code: "UNSUPPORTED_COMMAND", message: "unsupported file-transfer command" };
  }
  const command = ctx.command as FileTransferCommand;
  const op: FileTransferAuditOp = command;
  const params = asOptionalRecord(ctx.params) ?? {};
  const requestedPath = readPath(params);
  const nodeDisplayName = ctx.node?.displayName;
  const startedAt = Date.now();

  if (!requestedPath) {
    return { ok: false, code: "INVALID_PARAMS", message: `${op} path required` };
  }
  try {
    validateFetchMaxBytesParam(command, params);
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const gate = await requestApproval({
    ctx,
    op,
    kind: commandKind(command),
    path: requestedPath,
    startedAt,
  });
  if (!gate.ok) {
    return { ok: false, code: gate.code, message: gate.message };
  }

  let forwardedParams: Record<string, unknown>;
  try {
    forwardedParams = prepareParams({
      command,
      params,
      followSymlinks: gate.followSymlinks,
      maxBytes: gate.maxBytes,
    });
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  let boundCanonicalPath: string | undefined;
  let boundFilesystemIdentity: PathBinding | undefined;
  if (command === "file.fetch") {
    const preflight = await runPathPreflight({
      ctx,
      op,
      kind: "read",
      authorization: gate,
      params: forwardedParams,
      requestedPath,
      startedAt,
    });
    if (!preflight.ok) {
      return preflight.result;
    }
    boundCanonicalPath = preflight.canonicalPath;
    boundFilesystemIdentity = preflight.binding;
  } else if (command === "file.write") {
    const preflight = await runPathPreflight({
      ctx,
      op,
      kind: "write",
      authorization: gate,
      params: forwardedParams,
      requestedPath,
      startedAt,
    });
    if (!preflight.ok) {
      return preflight.result;
    }
    boundCanonicalPath = preflight.canonicalPath;
    boundFilesystemIdentity = preflight.binding;
  } else if (command === "dir.fetch") {
    const preflight = await runDirFetchPreflight({
      ctx,
      op,
      authorization: gate,
      params: forwardedParams,
      requestedPath,
      startedAt,
    });
    if (!preflight.ok) {
      return preflight.result;
    }
    boundCanonicalPath = preflight.canonicalPath;
    boundFilesystemIdentity = preflight.binding;
  } else if (command === "dir.list") {
    const preflight = await runPathPreflight({
      ctx,
      op,
      kind: "read",
      authorization: gate,
      params: forwardedParams,
      requestedPath,
      startedAt,
    });
    if (!preflight.ok) {
      return preflight.result;
    }
    boundCanonicalPath = preflight.canonicalPath;
    boundFilesystemIdentity = preflight.binding;
  }

  if (boundCanonicalPath !== undefined) {
    // The node must reject target drift before the final filesystem effect.
    forwardedParams.expectedCanonicalPath = boundCanonicalPath;
    forwardedParams.expectedBinding = boundFilesystemIdentity;
  }

  const result = await ctx.invokeNode({ params: forwardedParams });
  if (!result.ok) {
    await appendFileTransferAudit({
      op,
      nodeId: ctx.nodeId,
      nodeDisplayName,
      requestedPath,
      decision: "error",
      errorCode: result.code,
      errorMessage: result.message,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: false,
      code: result.code,
      message: `${op} failed: ${result.message}`,
      details: result.details,
      unavailable: true,
    };
  }

  const payload = readResultPayload(result);
  if (payload?.ok === false) {
    await appendFileTransferAudit({
      op,
      nodeId: ctx.nodeId,
      nodeDisplayName,
      requestedPath,
      canonicalPath: typeof payload.canonicalPath === "string" ? payload.canonicalPath : undefined,
      decision: "error",
      errorCode: typeof payload.code === "string" ? payload.code : undefined,
      errorMessage: typeof payload.message === "string" ? payload.message : undefined,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  const canonicalPath = payload && typeof payload.path === "string" ? payload.path : "";
  if (!canonicalPath) {
    return policyDeniedResult({
      op,
      code: "CANONICAL_PATH_MISSING",
      message: "node result did not return a canonical path",
    });
  }
  if (boundCanonicalPath !== undefined && boundCanonicalPath !== canonicalPath) {
    return policyDeniedResult({
      op,
      code: "CANONICAL_PATH_CHANGED",
      message: "the canonical path changed after preflight; refusing the result",
      details: { path: canonicalPath },
    });
  }
  const canonicalDeny = await validateCanonicalAuthorization({
    ctx,
    op,
    kind: commandKind(command),
    authorization: gate,
    requestedPath,
    canonicalPath,
    startedAt,
  });
  if (canonicalDeny) {
    return canonicalDeny;
  }
  let verifiedDirFetchArchive: { sizeBytes: number; sha256: string } | undefined;
  if (command === "dir.fetch") {
    const archiveEntries = await listDirFetchArchiveEntries(payload);
    if (!archiveEntries.ok) {
      await appendFileTransferAudit({
        op,
        nodeId: ctx.nodeId,
        nodeDisplayName,
        requestedPath,
        canonicalPath,
        decision: "error",
        errorCode: archiveEntries.code,
        reason: archiveEntries.reason,
        durationMs: Date.now() - startedAt,
      });
      return policyDeniedResult({
        op,
        code: archiveEntries.code,
        message: `${archiveEntries.reason}; refusing archive transfer`,
        details: { path: canonicalPath, reason: archiveEntries.reason },
      });
    }
    const archiveDeny = await validateDirFetchEntries({
      ctx,
      op,
      authorization: gate,
      requestedPath,
      canonicalPath,
      entries: archiveEntries.entries,
      startedAt,
      phase: "archive",
    });
    if (archiveDeny) {
      return archiveDeny;
    }
    verifiedDirFetchArchive = {
      sizeBytes: archiveEntries.sizeBytes,
      sha256: archiveEntries.sha256,
    };
  }

  let standingApprovalWarning: string | undefined;
  if (gate.persist) {
    try {
      await persistLiteralGrant({
        nodeId: ctx.nodeId,
        command,
        requestedPath,
        canonicalPath,
        pendingReapprovalSelector: gate.pendingReapprovalSelector,
      });
    } catch (error) {
      standingApprovalWarning =
        "The transfer succeeded, but the standing approval was not saved. Run the command again and choose allow-always, or use allow-once.";
      await appendFileTransferAudit({
        op,
        nodeId: ctx.nodeId,
        nodeDisplayName,
        requestedPath,
        canonicalPath,
        decision: "error",
        errorCode: "APPROVAL_PERSIST_FAILED",
        reason: `standing approval persistence failed: ${String(error)}`,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  await appendFileTransferAudit({
    op,
    nodeId: ctx.nodeId,
    nodeDisplayName,
    requestedPath,
    canonicalPath,
    decision: "allowed",
    sizeBytes: readAuditSizeBytes(command, payload, verifiedDirFetchArchive?.sizeBytes),
    sha256:
      command === "dir.fetch"
        ? verifiedDirFetchArchive?.sha256
        : typeof payload?.sha256 === "string"
          ? payload.sha256
          : undefined,
    durationMs: Date.now() - startedAt,
  });

  return standingApprovalWarning && payload
    ? { ok: true, payload: { ...payload, standingApprovalWarning } }
    : result;
}

export function createFileTransferNodeInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [...FILE_TRANSFER_NODE_INVOKE_COMMANDS],
    handle: handleFileTransferInvoke,
  };
}
