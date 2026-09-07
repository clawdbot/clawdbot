// File Transfer plugin module implements node invoke policy behavior.
import crypto from "node:crypto";
import { ARCHIVE_LIMIT_ERROR_CODE, ArchiveLimitError } from "openclaw/plugin-sdk/archive";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { appendFileTransferAudit, type FileTransferAuditOp } from "./audit.js";
import { inspectDirFetchArchive } from "./dir-fetch-archive.js";
import { DIR_FETCH_MAX_ENTRIES } from "./dir-fetch-limits.js";
import { commandKind, requestApproval } from "./node-invoke-policy-approval.js";
import {
  FILE_TRANSFER_NODE_INVOKE_COMMANDS,
  type FileTransferNodeInvokeCommand,
} from "./node-invoke-policy-commands.js";
import { prepareParams, validateFetchMaxBytesParam } from "./node-invoke-policy-params.js";
import {
  policyDeniedResult,
  runDirFetchPreflight,
  runPathPreflight,
  validateCanonicalAuthorization,
  validateDirFetchEntries,
} from "./node-invoke-policy-preflight.js";
import type { PathBinding } from "./path-binding.js";
import { persistLiteralGrant } from "./policy.js";
const DIR_FETCH_ARCHIVE_INSPECTION_TIMEOUT_MS = 30_000;

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

async function verifyDirFetchArchive(
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
  try {
    const entries = await inspectDirFetchArchive(
      tarBuffer,
      DIR_FETCH_ARCHIVE_INSPECTION_TIMEOUT_MS,
    );
    return { ok: true, entries, sizeBytes, sha256 };
  } catch (error) {
    const tooMany =
      error instanceof ArchiveLimitError &&
      error.code === ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT;
    return {
      ok: false,
      code: tooMany ? "ARCHIVE_ENTRIES_TOO_MANY" : "ARCHIVE_ENTRIES_UNREADABLE",
      reason: tooMany
        ? `dir.fetch archive contains more than ${DIR_FETCH_MAX_ENTRIES} entries`
        : `dir.fetch archive inspection failed: ${formatErrorMessage(error)}`,
    };
  }
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
    const archiveEntries = await verifyDirFetchArchive(payload);
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
