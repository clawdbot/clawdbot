import type {
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { appendFileTransferAudit, type FileTransferAuditOp } from "./audit.js";
import { type GrantedAuthorization, promptVerb } from "./node-invoke-policy-approval.js";
import { readPathBinding, type PathBinding } from "./path-binding.js";
import {
  evaluateFilePolicy,
  evaluateFilePolicyConstraints,
  type FilePolicyKind,
} from "./policy.js";

export const DIR_FETCH_MAX_ENTRIES = 5000;

function readResultPayload(result: { payload?: unknown }): Record<string, unknown> | null {
  return asNullableRecord(result.payload);
}

function joinRemotePolicyPath(root: string, relPath: string): string {
  const rel = relPath.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!rel || rel === ".") {
    return root;
  }
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const cleanRoot = root.replace(/[\\/]$/u, "");
  const prefix = cleanRoot || sep;
  return `${prefix}${prefix.endsWith(sep) ? "" : sep}${rel.split("/").join(sep)}`;
}

function validateDirFetchPreflightEntry(
  entry: string,
): { ok: true } | { ok: false; reason: string } {
  if (entry.includes("\0")) {
    return { ok: false, reason: "entry contains NUL byte" };
  }
  const normalized = entry.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!normalized || normalized === ".") {
    return { ok: false, reason: "entry is empty" };
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) {
    return { ok: false, reason: "entry is absolute" };
  }
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    return { ok: false, reason: "entry contains '..' traversal" };
  }
  return { ok: true };
}

export async function validateDirFetchEntries(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
  authorization: GrantedAuthorization;
  requestedPath: string;
  canonicalPath: string;
  entries: unknown;
  startedAt: number;
  phase: "preflight" | "archive";
}): Promise<OpenClawPluginNodeInvokePolicyResult | null> {
  const nodeDisplayName = input.ctx.node?.displayName;
  const missingCode =
    input.phase === "preflight" ? "PREFLIGHT_ENTRIES_MISSING" : "ARCHIVE_ENTRIES_MISSING";
  const invalidCode =
    input.phase === "preflight" ? "PREFLIGHT_ENTRY_INVALID" : "ARCHIVE_ENTRY_INVALID";
  const tooManyCode =
    input.phase === "preflight" ? "PREFLIGHT_ENTRIES_TOO_MANY" : "ARCHIVE_ENTRIES_TOO_MANY";
  if (!Array.isArray(input.entries)) {
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.requestedPath,
      canonicalPath: input.canonicalPath,
      decision: "error",
      errorCode: missingCode,
      reason: `dir.fetch ${input.phase} did not return entries`,
      durationMs: Date.now() - input.startedAt,
    });
    return policyDeniedResult({
      op: input.op,
      code: missingCode,
      message: `dir.fetch ${input.phase} did not return entries; refusing archive transfer`,
      details: { path: input.canonicalPath },
    });
  }
  if (input.entries.length > DIR_FETCH_MAX_ENTRIES) {
    const reason = `dir.fetch ${input.phase} contains ${input.entries.length} entries; limit ${DIR_FETCH_MAX_ENTRIES}`;
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.requestedPath,
      canonicalPath: input.canonicalPath,
      decision: "denied:policy",
      errorCode: tooManyCode,
      reason,
      durationMs: Date.now() - input.startedAt,
    });
    return policyDeniedResult({
      op: input.op,
      code: tooManyCode,
      message: `${reason}; refusing archive transfer`,
      details: { path: input.canonicalPath, reason },
    });
  }

  const entries: string[] = [];
  for (const entry of input.entries) {
    if (typeof entry !== "string" || entry.length === 0) {
      await appendFileTransferAudit({
        op: input.op,
        nodeId: input.ctx.nodeId,
        nodeDisplayName,
        requestedPath: input.requestedPath,
        canonicalPath: input.canonicalPath,
        decision: "denied:policy",
        errorCode: invalidCode,
        reason: "entry is not a non-empty string",
        durationMs: Date.now() - input.startedAt,
      });
      return policyDeniedResult({
        op: input.op,
        code: invalidCode,
        message: `directory ${input.phase} entry is invalid: entry is not a non-empty string`,
        details: { path: input.canonicalPath, reason: "entry is not a non-empty string" },
      });
    }
    const entryValidation = validateDirFetchPreflightEntry(entry);
    if (!entryValidation.ok) {
      const candidate = joinRemotePolicyPath(input.canonicalPath, entry);
      await appendFileTransferAudit({
        op: input.op,
        nodeId: input.ctx.nodeId,
        nodeDisplayName,
        requestedPath: input.requestedPath,
        canonicalPath: candidate,
        decision: "denied:policy",
        errorCode: invalidCode,
        reason: entryValidation.reason,
        durationMs: Date.now() - input.startedAt,
      });
      return policyDeniedResult({
        op: input.op,
        code: invalidCode,
        message: `directory ${input.phase} entry ${entry} is invalid: ${entryValidation.reason}`,
        details: { path: candidate, reason: entryValidation.reason },
      });
    }
    entries.push(entry);
  }

  const candidates = [
    input.canonicalPath,
    ...entries.map((entry) => joinRemotePolicyPath(input.canonicalPath, entry)),
  ];
  for (const candidate of candidates) {
    const policyInput = {
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      kind: "read" as const,
      command: "dir.fetch" as const,
      path: candidate,
      pluginConfig: input.ctx.pluginConfig,
    };
    const policy =
      input.authorization.source === "authored"
        ? evaluateFilePolicy(policyInput)
        : evaluateFilePolicyConstraints(policyInput);
    if (policy.ok) {
      continue;
    }
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.requestedPath,
      canonicalPath: candidate,
      decision: "denied:policy",
      errorCode: policy.code,
      reason: policy.reason,
      durationMs: Date.now() - input.startedAt,
    });
    return policyDeniedResult({
      op: input.op,
      code: "PATH_POLICY_DENIED",
      message: `directory ${input.phase} entry ${candidate} is not allowed by policy: ${policy.reason}`,
      details: { path: candidate, reason: policy.reason },
    });
  }

  return null;
}

export function policyDeniedResult(input: {
  op: FileTransferAuditOp;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): OpenClawPluginNodeInvokePolicyResult {
  return {
    ok: false,
    code: input.code,
    message: `${input.op} ${input.code}: ${input.message}`,
    ...(input.details ? { details: input.details } : {}),
  };
}

type PreflightResult =
  | {
      ok: true;
      payload: Record<string, unknown> | null;
      canonicalPath: string;
      binding: PathBinding;
    }
  | {
      ok: false;
      result: OpenClawPluginNodeInvokePolicyResult;
      canonicalChanged?: false;
    }
  | {
      ok: false;
      result: OpenClawPluginNodeInvokePolicyResult;
      canonicalChanged: true;
      canonicalPath: string;
    };

async function invokePreflight(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
  params: Record<string, unknown>;
  requestedPath: string;
  startedAt: number;
  expectedCanonicalPath?: string;
}): Promise<PreflightResult> {
  const nodeDisplayName = input.ctx.node?.displayName;
  const preflight = await input.ctx.invokeNode({
    params: {
      ...input.params,
      preflightOnly: true,
      ...(input.expectedCanonicalPath
        ? { expectedCanonicalPath: input.expectedCanonicalPath }
        : {}),
    },
  });
  if (!preflight.ok) {
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.requestedPath,
      decision: "error",
      errorCode: preflight.code,
      errorMessage: preflight.message,
      durationMs: Date.now() - input.startedAt,
    });
    return {
      ok: false,
      result: {
        ok: false,
        code: preflight.code,
        message: `${input.op} preflight failed: ${preflight.message}`,
        details: preflight.details,
        unavailable: true,
      },
    };
  }
  const payload = readResultPayload(preflight);
  if (payload?.ok === false) {
    const code = typeof payload.code === "string" ? payload.code : "PREFLIGHT_FAILED";
    const canonicalPath =
      typeof payload.canonicalPath === "string" ? payload.canonicalPath : undefined;
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.requestedPath,
      canonicalPath,
      decision: "error",
      errorCode: code,
      errorMessage: typeof payload.message === "string" ? payload.message : undefined,
      durationMs: Date.now() - input.startedAt,
    });
    if (code === "CANONICAL_PATH_CHANGED" && canonicalPath) {
      return {
        ok: false,
        result: preflight,
        canonicalChanged: true,
        canonicalPath,
      };
    }
    return { ok: false, result: preflight };
  }
  const canonicalPath = payload && typeof payload.path === "string" ? payload.path : "";
  if (!canonicalPath) {
    return {
      ok: false,
      result: policyDeniedResult({
        op: input.op,
        code: "PREFLIGHT_PATH_MISSING",
        message: "node preflight did not return a canonical path",
      }),
    };
  }
  const binding = readPathBinding(payload?.binding);
  const expectedBindingKind = input.op === "file.write" ? "write" : "existing";
  if (!binding || binding.kind !== expectedBindingKind) {
    return {
      ok: false,
      result: policyDeniedResult({
        op: input.op,
        code: "FILESYSTEM_IDENTITY_MISSING",
        message: "node preflight did not return a filesystem identity; update the node and retry",
      }),
    };
  }
  return { ok: true, payload, canonicalPath, binding };
}

export async function validateCanonicalAuthorization(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
  kind: FilePolicyKind;
  authorization: GrantedAuthorization;
  requestedPath: string;
  canonicalPath: string;
  startedAt: number;
}): Promise<OpenClawPluginNodeInvokePolicyResult | null> {
  const nodeDisplayName = input.ctx.node?.displayName;
  if (
    input.authorization.source === "literal" &&
    input.authorization.expectedCanonicalPath !== input.canonicalPath
  ) {
    const approval = await input.ctx.approvals?.request({
      title: `${promptVerb(input.op)} target changed: ${input.requestedPath}`,
      description: `The node now resolves this path to:\n${input.canonicalPath}\n\nApprove this exact canonical target for ${input.ctx.nodeId}.`,
      severity: input.kind === "write" ? "warning" : "info",
      toolName: input.op,
    });
    if (approval?.decision !== "allow-once" && approval?.decision !== "allow-always") {
      await appendFileTransferAudit({
        op: input.op,
        nodeId: input.ctx.nodeId,
        nodeDisplayName,
        requestedPath: input.requestedPath,
        canonicalPath: input.canonicalPath,
        decision: "denied:symlink_escape",
        errorCode: "CANONICAL_PATH_CHANGED",
        reason: "canonical path differs from the standing approval",
        durationMs: Date.now() - input.startedAt,
      });
      return policyDeniedResult({
        op: input.op,
        code: "CANONICAL_PATH_CHANGED",
        message: "the canonical path differs from the standing approval and was not reapproved",
        details: { path: input.canonicalPath },
      });
    }
    input.authorization.source = "approval";
    input.authorization.persist = approval.decision === "allow-always";
    input.authorization.expectedCanonicalPath = input.canonicalPath;
  }

  const policyInput = {
    nodeId: input.ctx.nodeId,
    nodeDisplayName,
    kind: input.kind,
    command: input.op,
    path: input.canonicalPath,
    pluginConfig: input.ctx.pluginConfig,
  };
  const policy =
    input.authorization.source === "authored"
      ? evaluateFilePolicy(policyInput)
      : evaluateFilePolicyConstraints(policyInput);
  if (policy.ok) {
    return null;
  }
  await appendFileTransferAudit({
    op: input.op,
    nodeId: input.ctx.nodeId,
    nodeDisplayName,
    requestedPath: input.requestedPath,
    canonicalPath: input.canonicalPath,
    decision: "denied:symlink_escape",
    errorCode: policy.code,
    reason: policy.reason,
    durationMs: Date.now() - input.startedAt,
  });
  return policyDeniedResult({
    op: input.op,
    code: "SYMLINK_TARGET_DENIED",
    message: `requested path resolved to ${input.canonicalPath} which is not allowed by policy`,
  });
}

async function invokeAuthorizedPreflight(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
  kind: FilePolicyKind;
  authorization: GrantedAuthorization;
  params: Record<string, unknown>;
  requestedPath: string;
  startedAt: number;
}): Promise<PreflightResult> {
  const expectedCanonicalPath =
    input.authorization.source === "literal"
      ? input.authorization.expectedCanonicalPath
      : undefined;
  const preflight = await invokePreflight({ ...input, expectedCanonicalPath });
  if (preflight.ok || preflight.canonicalChanged !== true) {
    return preflight;
  }

  const denied = await validateCanonicalAuthorization({
    ctx: input.ctx,
    op: input.op,
    kind: input.kind,
    authorization: input.authorization,
    requestedPath: input.requestedPath,
    canonicalPath: preflight.canonicalPath,
    startedAt: input.startedAt,
  });
  if (denied) {
    return { ok: false, result: denied };
  }

  // The operator approved the newly resolved target. Bind the retry to that
  // exact target so another replacement cannot race ahead of preflight I/O.
  const retry = await invokePreflight({
    ...input,
    expectedCanonicalPath: input.authorization.expectedCanonicalPath,
  });
  if (retry.ok || retry.canonicalChanged !== true) {
    return retry;
  }
  await appendFileTransferAudit({
    op: input.op,
    nodeId: input.ctx.nodeId,
    nodeDisplayName: input.ctx.node?.displayName,
    requestedPath: input.requestedPath,
    canonicalPath: retry.canonicalPath,
    decision: "denied:symlink_escape",
    errorCode: "CANONICAL_PATH_CHANGED",
    reason: "canonical path changed again after reapproval",
    durationMs: Date.now() - input.startedAt,
  });
  return {
    ok: false,
    result: policyDeniedResult({
      op: input.op,
      code: "CANONICAL_PATH_CHANGED",
      message: "the canonical path changed again after reapproval; retry the operation",
      details: { path: retry.canonicalPath },
    }),
  };
}

export async function runPathPreflight(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
  kind: FilePolicyKind;
  authorization: GrantedAuthorization;
  params: Record<string, unknown>;
  requestedPath: string;
  startedAt: number;
}): Promise<
  | { ok: true; canonicalPath: string; binding: PathBinding }
  | { ok: false; result: OpenClawPluginNodeInvokePolicyResult }
> {
  const preflight = await invokeAuthorizedPreflight(input);
  if (!preflight.ok) {
    return { ok: false, result: preflight.result };
  }
  const denied = await validateCanonicalAuthorization({
    ctx: input.ctx,
    op: input.op,
    kind: input.kind,
    authorization: input.authorization,
    requestedPath: input.requestedPath,
    canonicalPath: preflight.canonicalPath,
    startedAt: input.startedAt,
  });
  return denied
    ? { ok: false, result: denied }
    : { ok: true, canonicalPath: preflight.canonicalPath, binding: preflight.binding };
}

export async function runDirFetchPreflight(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
  authorization: GrantedAuthorization;
  params: Record<string, unknown>;
  requestedPath: string;
  startedAt: number;
}): Promise<
  | { ok: true; canonicalPath: string; binding: PathBinding }
  | { ok: false; result: OpenClawPluginNodeInvokePolicyResult }
> {
  const preflight = await invokeAuthorizedPreflight({ ...input, kind: "read" });
  if (!preflight.ok) {
    return { ok: false, result: preflight.result };
  }
  const denied = await validateCanonicalAuthorization({
    ctx: input.ctx,
    op: input.op,
    kind: "read",
    authorization: input.authorization,
    requestedPath: input.requestedPath,
    canonicalPath: preflight.canonicalPath,
    startedAt: input.startedAt,
  });
  if (denied) {
    return { ok: false, result: denied };
  }
  const entryDeny = await validateDirFetchEntries({
    ctx: input.ctx,
    op: input.op,
    authorization: input.authorization,
    requestedPath: input.requestedPath,
    canonicalPath: preflight.canonicalPath,
    entries: preflight.payload?.entries,
    startedAt: input.startedAt,
    phase: "preflight",
  });
  return entryDeny
    ? { ok: false, result: entryDeny }
    : { ok: true, canonicalPath: preflight.canonicalPath, binding: preflight.binding };
}
