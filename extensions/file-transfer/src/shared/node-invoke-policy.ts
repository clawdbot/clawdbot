import { spawn } from "node:child_process";
import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { appendFileTransferAudit, type FileTransferAuditOp } from "./audit.js";
import { evaluateFilePolicy, persistAllowAlways, type FilePolicyKind } from "./policy.js";

const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DIR_FETCH_ARCHIVE_LIST_TIMEOUT_MS = 30_000;
const DIR_FETCH_ARCHIVE_LIST_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

type FileTransferCommand = "file.fetch" | "dir.list" | "dir.fetch" | "file.write";

const COMMANDS: FileTransferCommand[] = ["file.fetch", "dir.list", "dir.fetch", "file.write"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readPath(params: Record<string, unknown>): string {
  return typeof params.path === "string" ? params.path.trim() : "";
}

function readMaxBytes(input: {
  value: unknown;
  defaultValue: number;
  hardMax: number;
  policyMax?: number;
}): number {
  const requested =
    typeof input.value === "number" && Number.isFinite(input.value)
      ? Math.floor(input.value)
      : input.defaultValue;
  const clamped = Math.max(1, Math.min(requested, input.hardMax));
  return input.policyMax ? Math.min(clamped, input.policyMax) : clamped;
}

function commandKind(command: FileTransferCommand): FilePolicyKind {
  return command === "file.write" ? "write" : "read";
}

function promptVerb(command: FileTransferCommand): string {
  switch (command) {
    case "dir.fetch":
      return "Fetch directory";
    case "dir.list":
      return "List directory";
    case "file.write":
      return "Write file";
    case "file.fetch":
      return "Read file";
  }
  return command;
}

async function requestApproval(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
  kind: FilePolicyKind;
  path: string;
  startedAt: number;
}): Promise<
  | { ok: true; followSymlinks: boolean; maxBytes?: number }
  | { ok: false; message: string; code: string }
> {
  const nodeDisplayName = input.ctx.node?.displayName;
  const decision = evaluateFilePolicy({
    nodeId: input.ctx.nodeId,
    nodeDisplayName,
    kind: input.kind,
    path: input.path,
    pluginConfig: input.ctx.pluginConfig,
  });

  if (decision.ok && decision.reason === "matched-allow") {
    return {
      ok: true,
      followSymlinks: decision.followSymlinks,
      maxBytes: decision.maxBytes,
    };
  }

  const shouldAsk =
    (decision.ok && decision.reason === "ask-always") || (!decision.ok && decision.askable);
  if (!shouldAsk) {
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.path,
      decision:
        !decision.ok && decision.code === "NO_POLICY" ? "denied:no_policy" : "denied:policy",
      errorCode: decision.ok ? undefined : decision.code,
      reason: decision.ok ? decision.reason : decision.reason,
      durationMs: Date.now() - input.startedAt,
    });
    return {
      ok: false,
      code: decision.ok ? "POLICY_DENIED" : decision.code,
      message: `${input.op} ${decision.ok ? "POLICY_DENIED" : decision.code}: ${decision.reason}`,
    };
  }

  const approvals = input.ctx.approvals;
  if (!approvals) {
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.path,
      decision: "denied:approval",
      reason: "plugin approvals unavailable",
      durationMs: Date.now() - input.startedAt,
    });
    return {
      ok: false,
      code: "APPROVAL_UNAVAILABLE",
      message: `${input.op} APPROVAL_UNAVAILABLE: plugin approvals unavailable`,
    };
  }

  const verb = promptVerb(input.op);
  const subject = nodeDisplayName ?? input.ctx.nodeId;
  const approval = await approvals.request({
    title: `${verb}: ${input.path}`,
    description: `Allow ${verb.toLowerCase()} on ${subject}\nPath: ${input.path}\nKind: ${input.kind}\n\n"allow-always" appends this exact path to allow${input.kind === "read" ? "Read" : "Write"}Paths.`,
    severity: input.kind === "write" ? "warning" : "info",
    toolName: input.op,
  });

  if (approval.decision === "deny" || approval.decision === null || !approval.decision) {
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.path,
      decision: "denied:approval",
      reason: approval.decision === "deny" ? "operator denied" : "no operator available",
      durationMs: Date.now() - input.startedAt,
    });
    return {
      ok: false,
      code: approval.decision === "deny" ? "APPROVAL_DENIED" : "APPROVAL_UNAVAILABLE",
      message:
        approval.decision === "deny"
          ? `${input.op} APPROVAL_DENIED: operator denied the prompt`
          : `${input.op} APPROVAL_UNAVAILABLE: no operator client connected to approve the request`,
    };
  }

  if (approval.decision === "allow-always") {
    try {
      await persistAllowAlways({
        nodeId: input.ctx.nodeId,
        nodeDisplayName,
        kind: input.kind,
        path: input.path,
      });
      const refreshed = evaluateFilePolicy({
        nodeId: input.ctx.nodeId,
        nodeDisplayName,
        kind: input.kind,
        path: input.path,
        pluginConfig: input.ctx.pluginConfig,
      });
      if (refreshed.ok) {
        await appendFileTransferAudit({
          op: input.op,
          nodeId: input.ctx.nodeId,
          nodeDisplayName,
          requestedPath: input.path,
          decision: "allowed:always",
          durationMs: Date.now() - input.startedAt,
        });
        return {
          ok: true,
          followSymlinks: refreshed.followSymlinks,
          maxBytes: refreshed.maxBytes,
        };
      }
    } catch (error) {
      await appendFileTransferAudit({
        op: input.op,
        nodeId: input.ctx.nodeId,
        nodeDisplayName,
        requestedPath: input.path,
        decision: "allowed:always",
        reason: `persist failed: ${String(error)}`,
        durationMs: Date.now() - input.startedAt,
      });
      return {
        ok: true,
        followSymlinks: decision.ok ? decision.followSymlinks : false,
        maxBytes: decision.maxBytes,
      };
    }
  }

  await appendFileTransferAudit({
    op: input.op,
    nodeId: input.ctx.nodeId,
    nodeDisplayName,
    requestedPath: input.path,
    decision: approval.decision === "allow-always" ? "allowed:always" : "allowed:once",
    durationMs: Date.now() - input.startedAt,
  });
  return {
    ok: true,
    followSymlinks: decision.ok ? decision.followSymlinks : false,
    maxBytes: decision.maxBytes,
  };
}

function prepareParams(input: {
  command: FileTransferCommand;
  params: Record<string, unknown>;
  followSymlinks: boolean;
  maxBytes?: number;
}): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...input.params,
    followSymlinks: input.followSymlinks,
  };
  delete next.preflightOnly;
  if (input.command === "file.fetch") {
    next.maxBytes = readMaxBytes({
      value: input.params.maxBytes,
      defaultValue: FILE_FETCH_DEFAULT_MAX_BYTES,
      hardMax: FILE_FETCH_HARD_MAX_BYTES,
      policyMax: input.maxBytes,
    });
  } else if (input.command === "dir.fetch") {
    next.maxBytes = readMaxBytes({
      value: input.params.maxBytes,
      defaultValue: DIR_FETCH_DEFAULT_MAX_BYTES,
      hardMax: DIR_FETCH_HARD_MAX_BYTES,
      policyMax: input.maxBytes,
    });
  }
  return next;
}

function readResultPayload(result: { payload?: unknown }): Record<string, unknown> | null {
  return result.payload && typeof result.payload === "object" && !Array.isArray(result.payload)
    ? (result.payload as Record<string, unknown>)
    : null;
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

function normalizeTarEntryPath(entry: string): string | null {
  const normalized = entry.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  return normalized.length > 0 ? normalized : null;
}

async function listDirFetchArchiveEntries(
  payload: Record<string, unknown> | null,
): Promise<{ ok: true; entries: string[] } | { ok: false; code: string; reason: string }> {
  const tarBase64 = typeof payload?.tarBase64 === "string" ? payload.tarBase64 : "";
  if (!tarBase64) {
    return {
      ok: false,
      code: "ARCHIVE_ENTRIES_MISSING",
      reason: "dir.fetch archive did not return tarBase64",
    };
  }
  const tarBuffer = Buffer.from(tarBase64, "base64");
  return await new Promise<
    { ok: true; entries: string[] } | { ok: false; code: string; reason: string }
  >((resolve) => {
    const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
    const child = spawn(tarBin, ["-tzf", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    const watchdog = setTimeout(() => {
      aborted = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve({
        ok: false,
        code: "ARCHIVE_ENTRIES_UNREADABLE",
        reason: "tar -tzf timed out",
      });
    }, DIR_FETCH_ARCHIVE_LIST_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > DIR_FETCH_ARCHIVE_LIST_MAX_OUTPUT_BYTES) {
        aborted = true;
        clearTimeout(watchdog);
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
        resolve({
          ok: false,
          code: "ARCHIVE_ENTRIES_UNREADABLE",
          reason: "tar -tzf output too large",
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      if (aborted) {
        return;
      }
      if (code !== 0) {
        resolve({
          ok: false,
          code: "ARCHIVE_ENTRIES_UNREADABLE",
          reason: `tar -tzf exited ${code}: ${stderr.slice(0, 200)}`,
        });
        return;
      }
      resolve({
        ok: true,
        entries: stdout
          .split("\n")
          .map(normalizeTarEntryPath)
          .filter((entry): entry is string => entry !== null),
      });
    });
    child.on("error", (error) => {
      clearTimeout(watchdog);
      if (!aborted) {
        resolve({
          ok: false,
          code: "ARCHIVE_ENTRIES_UNREADABLE",
          reason: `tar -tzf error: ${String(error)}`,
        });
      }
    });
    child.stdin.end(tarBuffer);
  });
}

async function validateDirFetchEntries(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
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
    const policy = evaluateFilePolicy({
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      kind: "read",
      path: candidate,
      pluginConfig: input.ctx.pluginConfig,
    });
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

function policyDeniedResult(input: {
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
    }
  | {
      ok: false;
      result: OpenClawPluginNodeInvokePolicyResult;
    };

async function invokePreflight(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
  params: Record<string, unknown>;
  requestedPath: string;
  startedAt: number;
}): Promise<PreflightResult> {
  const nodeDisplayName = input.ctx.node?.displayName;
  const preflight = await input.ctx.invokeNode({
    params: {
      ...input.params,
      preflightOnly: true,
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
        message: `${input.op} failed: ${preflight.message}`,
        details: preflight.details,
        unavailable: true,
      },
    };
  }

  const payload = readResultPayload(preflight);
  if (payload?.ok === false) {
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.requestedPath,
      canonicalPath: typeof payload.canonicalPath === "string" ? payload.canonicalPath : undefined,
      decision: "error",
      errorCode: typeof payload.code === "string" ? payload.code : undefined,
      errorMessage: typeof payload.message === "string" ? payload.message : undefined,
      durationMs: Date.now() - input.startedAt,
    });
    return { ok: false, result: preflight };
  }

  const canonicalPath =
    payload && typeof payload.path === "string" && payload.path
      ? payload.path
      : input.requestedPath;
  return { ok: true, payload, canonicalPath };
}

async function runPathPreflight(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
  kind: FilePolicyKind;
  params: Record<string, unknown>;
  requestedPath: string;
  startedAt: number;
}): Promise<OpenClawPluginNodeInvokePolicyResult | null> {
  const preflight = await invokePreflight(input);
  if (!preflight.ok) {
    return preflight.result;
  }

  const nodeDisplayName = input.ctx.node?.displayName;
  const { canonicalPath } = preflight;
  if (canonicalPath === input.requestedPath) {
    return null;
  }

  const policy = evaluateFilePolicy({
    nodeId: input.ctx.nodeId,
    nodeDisplayName,
    kind: input.kind,
    path: canonicalPath,
    pluginConfig: input.ctx.pluginConfig,
  });
  if (policy.ok) {
    return null;
  }

  await appendFileTransferAudit({
    op: input.op,
    nodeId: input.ctx.nodeId,
    nodeDisplayName,
    requestedPath: input.requestedPath,
    canonicalPath,
    decision: "denied:symlink_escape",
    errorCode: policy.code,
    reason: policy.reason,
    durationMs: Date.now() - input.startedAt,
  });
  return {
    ok: false,
    code: "SYMLINK_TARGET_DENIED",
    message: `${input.op} SYMLINK_TARGET_DENIED: requested path resolved to ${canonicalPath} which is not allowed by policy`,
  };
}

async function runDirFetchPreflight(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
  params: Record<string, unknown>;
  requestedPath: string;
  startedAt: number;
}): Promise<OpenClawPluginNodeInvokePolicyResult | null> {
  const preflight = await invokePreflight(input);
  if (!preflight.ok) {
    return preflight.result;
  }

  return await validateDirFetchEntries({
    ctx: input.ctx,
    op: input.op,
    requestedPath: input.requestedPath,
    canonicalPath: preflight.canonicalPath,
    entries: preflight.payload?.entries,
    startedAt: input.startedAt,
    phase: "preflight",
  });
}

async function handleFileTransferInvoke(
  ctx: OpenClawPluginNodeInvokePolicyContext,
): Promise<OpenClawPluginNodeInvokePolicyResult> {
  if (!COMMANDS.includes(ctx.command as FileTransferCommand)) {
    return { ok: false, code: "UNSUPPORTED_COMMAND", message: "unsupported file-transfer command" };
  }
  const command = ctx.command as FileTransferCommand;
  const op: FileTransferAuditOp = command;
  const params = asRecord(ctx.params);
  const requestedPath = readPath(params);
  const nodeDisplayName = ctx.node?.displayName;
  const startedAt = Date.now();

  if (!requestedPath) {
    return { ok: false, code: "INVALID_PARAMS", message: `${op} path required` };
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

  const forwardedParams = prepareParams({
    command,
    params,
    followSymlinks: gate.followSymlinks,
    maxBytes: gate.maxBytes,
  });
  if (command === "file.fetch") {
    const preflightDeny = await runPathPreflight({
      ctx,
      op,
      kind: "read",
      params: forwardedParams,
      requestedPath,
      startedAt,
    });
    if (preflightDeny) {
      return preflightDeny;
    }
  } else if (command === "file.write") {
    const preflightDeny = await runPathPreflight({
      ctx,
      op,
      kind: "write",
      params: forwardedParams,
      requestedPath,
      startedAt,
    });
    if (preflightDeny) {
      return preflightDeny;
    }
  } else if (command === "dir.fetch") {
    const preflightDeny = await runDirFetchPreflight({
      ctx,
      op,
      params: forwardedParams,
      requestedPath,
      startedAt,
    });
    if (preflightDeny) {
      return preflightDeny;
    }
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

  const canonicalPath =
    payload && typeof payload.path === "string" && payload.path ? payload.path : requestedPath;
  if (canonicalPath !== requestedPath) {
    const postflight = evaluateFilePolicy({
      nodeId: ctx.nodeId,
      nodeDisplayName,
      kind: commandKind(command),
      path: canonicalPath,
      pluginConfig: ctx.pluginConfig,
    });
    if (!postflight.ok) {
      await appendFileTransferAudit({
        op,
        nodeId: ctx.nodeId,
        nodeDisplayName,
        requestedPath,
        canonicalPath,
        decision: "denied:symlink_escape",
        errorCode: postflight.code,
        reason: postflight.reason,
        durationMs: Date.now() - startedAt,
      });
      return {
        ok: false,
        code: "SYMLINK_TARGET_DENIED",
        message: `${op} SYMLINK_TARGET_DENIED: requested path resolved to ${canonicalPath} which is not allowed by policy`,
      };
    }
  }
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
      requestedPath,
      canonicalPath,
      entries: archiveEntries.entries,
      startedAt,
      phase: "archive",
    });
    if (archiveDeny) {
      return archiveDeny;
    }
  }

  await appendFileTransferAudit({
    op,
    nodeId: ctx.nodeId,
    nodeDisplayName,
    requestedPath,
    canonicalPath,
    decision: "allowed",
    sizeBytes: typeof payload?.size === "number" ? payload.size : undefined,
    sha256: typeof payload?.sha256 === "string" ? payload.sha256 : undefined,
    durationMs: Date.now() - startedAt,
  });

  return result;
}

export function createFileTransferNodeInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: COMMANDS,
    handle: handleFileTransferInvoke,
  };
}
