// CLI for reading and mutating exec approval allowlists locally, via gateway, or via node.
import fs from "node:fs/promises";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { Command } from "commander";
import JSON5 from "json5";
import {
  isWellFormedApprovalId,
  type ApprovalDecision,
  type ApprovalGetResult,
  type ApprovalKind,
  type ApprovalResolveResult,
  type ApprovalSnapshot,
} from "../../packages/gateway-protocol/src/index.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { readBestEffortConfig, type OpenClawConfig } from "../config/config.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE, type OperatorScope } from "../gateway/method-scopes.js";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  collectExecPolicyScopeSnapshots,
  SESSION_EXEC_OVERRIDES_NOTE,
  type ExecPolicyScopeSnapshot,
} from "../infra/exec-approvals-effective.js";
import {
  mergeExecApprovalsSocketDefaults,
  normalizeExecApprovals,
  readExecApprovalsSnapshot,
  updateExecApprovals,
  type ExecApprovalsAgent,
  type ExecApprovalsDefaults,
  type ExecApprovalsFile,
} from "../infra/exec-approvals.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { defaultRuntime } from "../runtime.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { nodesCallOpts, resolveNodeId } from "./nodes-cli/rpc.js";
import type { NodesRpcOpts } from "./nodes-cli/types.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type FileExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
  resolvedDefaults?: Required<ExecApprovalsDefaults>;
};

type NativeExecApprovalAction = "allow" | "deny" | "prompt";
type NativeExecApprovalRule = {
  pattern: string;
  action: NativeExecApprovalAction;
  shells?: string[];
  description?: string;
  enabled?: boolean;
};
type NativeExecApprovalPolicy = {
  defaultAction?: NativeExecApprovalAction;
  rules: NativeExecApprovalRule[];
};
type NativeExecApprovalsSnapshot =
  | {
      enabled: true;
      hash: string;
      baseHash?: string;
      defaultAction: NativeExecApprovalAction;
      rules: NativeExecApprovalRule[];
      constraints?: Record<string, boolean>;
    }
  | { enabled: false; message?: string };
type ExecApprovalsSnapshot = FileExecApprovalsSnapshot | NativeExecApprovalsSnapshot;

type ConfigSnapshotLike = {
  config?: OpenClawConfig;
};
type ConfigLoadResult = {
  config: OpenClawConfig | null;
  timedOut: boolean;
};
type ApprovalsTargetSource = "gateway" | "node" | "local";
type EffectivePolicyReport = {
  scopes: ExecPolicyScopeSnapshot[];
  note?: string;
};
const APPROVALS_GET_DEFAULT_TIMEOUT_MS = 60_000;
const EXEC_APPROVALS_STDIN_MAX_BYTES = 1024 * 1024;

type ExecApprovalsCliOpts = NodesRpcOpts & {
  node?: string;
  gateway?: boolean;
  file?: string;
  stdin?: boolean;
  agent?: string;
  reason?: string;
};

type PendingApprovalCliEntry = {
  id: string;
  kind: ApprovalKind;
  agentId: string | null;
  sessionKey: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  summary: string;
};

const APPROVAL_DECISIONS = ["allow-once", "allow-always", "deny"] as const;
const PENDING_APPROVAL_SUMMARY_MAX_LENGTH = 96;
const APPROVAL_ID_TOKEN_PREFIX = "id64_";
const APPROVAL_TERMINAL_UNSAFE_CHAR =
  /^[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]$/u;

async function readStdin(
  stream: NodeJS.ReadableStream = process.stdin,
  maxBytes = EXEC_APPROVALS_STDIN_MAX_BYTES,
): Promise<string> {
  const bytes = await readByteStreamWithLimit(stream, {
    maxBytes,
    onOverflow: ({ maxBytes: limit }) => new Error(`Exec approvals stdin exceeds ${limit} bytes.`),
  });
  return bytes.toString("utf8");
}

async function readApprovalsFile(filePath: string): Promise<string> {
  // Explicit CLI file inputs have historically followed symlinks and readable
  // special files. Pin that opened target while bounding the bytes consumed.
  const handle = await fs.open(filePath, "r");
  try {
    return (await readFileDescriptorBounded(handle.fd, EXEC_APPROVALS_STDIN_MAX_BYTES)).toString(
      "utf8",
    );
  } finally {
    await handle.close();
  }
}

async function resolveTargetNodeId(opts: ExecApprovalsCliOpts): Promise<string | null> {
  if (opts.gateway) {
    return null;
  }
  const raw = normalizeOptionalString(opts.node) ?? "";
  if (!raw) {
    return null;
  }
  return await resolveNodeId(opts as NodesRpcOpts, raw);
}

async function loadSnapshot(
  opts: ExecApprovalsCliOpts,
  nodeId: string | null,
): Promise<ExecApprovalsSnapshot> {
  const method = nodeId ? "exec.approvals.node.get" : "exec.approvals.get";
  const params = nodeId ? { nodeId } : {};
  const snapshot = (await callGatewayFromCli(method, opts, params)) as ExecApprovalsSnapshot;
  return snapshot;
}

function loadSnapshotLocal(): ExecApprovalsSnapshot {
  const snapshot = readExecApprovalsSnapshot();
  return {
    path: snapshot.path,
    exists: snapshot.exists,
    hash: snapshot.hash,
    file: snapshot.file,
  };
}

function isFileApprovalsSnapshot(
  snapshot: ExecApprovalsSnapshot,
): snapshot is FileExecApprovalsSnapshot {
  return "file" in snapshot;
}

function isNativeApprovalsSnapshot(
  snapshot: ExecApprovalsSnapshot,
): snapshot is NativeExecApprovalsSnapshot {
  return "enabled" in snapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNativeAction(value: unknown, label: string): NativeExecApprovalAction {
  if (value === "allow" || value === "deny" || value === "prompt") {
    return value;
  }
  return exitWithError(`${label} must be allow, deny, or prompt.`);
}

function normalizeNativePolicyInput(value: unknown): NativeExecApprovalPolicy {
  if (!isRecord(value)) {
    exitWithError("Host-native exec approvals JSON must be an object.");
  }
  const unknownKeys = Object.keys(value).filter(
    (key) => key !== "defaultAction" && key !== "rules",
  );
  if (unknownKeys.length > 0) {
    exitWithError(`Unknown host-native exec approvals field: ${unknownKeys[0]}.`);
  }
  const defaultAction =
    value.defaultAction === undefined
      ? undefined
      : parseNativeAction(value.defaultAction, "defaultAction");
  if (!Array.isArray(value.rules)) {
    exitWithError("Host-native exec approvals rules must be an array.");
  }
  const rules = value.rules?.map((entry, index) => {
    if (!isRecord(entry)) {
      exitWithError(`Host-native exec approval rule ${index + 1} must be an object.`);
    }
    const unknownRuleKeys = Object.keys(entry).filter(
      (key) =>
        key !== "pattern" &&
        key !== "action" &&
        key !== "shells" &&
        key !== "description" &&
        key !== "enabled",
    );
    if (unknownRuleKeys.length > 0) {
      exitWithError(
        `Unknown host-native exec approval rule ${index + 1} field: ${unknownRuleKeys[0]}.`,
      );
    }
    const pattern = normalizeOptionalString(entry.pattern);
    if (!pattern) {
      exitWithError(`Host-native exec approval rule ${index + 1} requires pattern.`);
    }
    const action = parseNativeAction(
      entry.action,
      `Host-native exec approval rule ${index + 1} action`,
    );
    let shells: string[] | undefined;
    if (entry.shells !== undefined) {
      if (!Array.isArray(entry.shells)) {
        exitWithError(`Host-native exec approval rule ${index + 1} shells must be an array.`);
      }
      shells = entry.shells.map((shell) => {
        const normalized = typeof shell === "string" ? shell.trim() : "";
        if (!normalized) {
          exitWithError(
            `Host-native exec approval rule ${index + 1} shells must be non-empty strings.`,
          );
        }
        return normalized;
      });
    }
    if (entry.description !== undefined && typeof entry.description !== "string") {
      exitWithError(`Host-native exec approval rule ${index + 1} description must be a string.`);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      exitWithError(`Host-native exec approval rule ${index + 1} enabled must be a boolean.`);
    }
    return {
      pattern,
      action,
      ...(shells ? { shells } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
    };
  });
  return {
    ...(defaultAction ? { defaultAction } : {}),
    rules,
  };
}

async function saveSnapshotLocal(
  file: ExecApprovalsFile,
  baseHash: string,
): Promise<ExecApprovalsSnapshot> {
  const snapshot = await updateExecApprovals({
    baseHash,
    update: (current) =>
      mergeExecApprovalsSocketDefaults({
        normalized: normalizeExecApprovals(file),
        current,
      }),
  });
  if (!snapshot) {
    throw new Error("Exec approvals changed; reload and retry.");
  }
  return snapshot;
}

async function loadSnapshotTarget(opts: ExecApprovalsCliOpts): Promise<{
  snapshot: ExecApprovalsSnapshot;
  nodeId: string | null;
  source: ApprovalsTargetSource;
}> {
  if (!opts.gateway && !opts.node) {
    return { snapshot: loadSnapshotLocal(), nodeId: null, source: "local" };
  }
  const nodeId = await resolveTargetNodeId(opts);
  const snapshot = await loadSnapshot(opts, nodeId);
  return { snapshot, nodeId, source: nodeId ? "node" : "gateway" };
}

function exitWithError(message: string): never {
  defaultRuntime.error(message);
  defaultRuntime.exit(1);
  throw new Error(message);
}

function requireTrimmedNonEmpty(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    exitWithError(message);
  }
  return trimmed;
}

async function loadWritableSnapshotTarget(opts: ExecApprovalsCliOpts): Promise<{
  snapshot: FileExecApprovalsSnapshot | NativeExecApprovalsSnapshot;
  nodeId: string | null;
  source: ApprovalsTargetSource;
  targetLabel: string;
  baseHash: string;
  kind: "file" | "native";
}> {
  // Writes carry the base hash so gateway/node updates can reject stale snapshots.
  const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
  if (source === "local") {
    defaultRuntime.log(theme.muted("Writing local approvals."));
  }
  const targetLabel = source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway";
  if (isNativeApprovalsSnapshot(snapshot) && !snapshot.enabled) {
    exitWithError(
      "Host-native exec approvals are disabled on this node and cannot be configured remotely.",
    );
  }
  const baseHash = "hash" in snapshot ? snapshot.hash : undefined;
  if (!baseHash) {
    exitWithError("Exec approvals hash missing; reload and retry.");
  }
  const kind = isNativeApprovalsSnapshot(snapshot) ? "native" : "file";
  return { snapshot, nodeId, source, targetLabel, baseHash, kind };
}

type SaveSnapshotTargetedParams = {
  opts: ExecApprovalsCliOpts;
  source: ApprovalsTargetSource;
  nodeId: string | null;
  baseHash: string;
  targetLabel: string;
} & ({ file: ExecApprovalsFile } | { native: NativeExecApprovalPolicy });

async function saveSnapshotTargeted(params: SaveSnapshotTargetedParams): Promise<void> {
  let next: ExecApprovalsSnapshot;
  if ("native" in params) {
    if (params.source !== "node" || !params.nodeId) {
      exitWithError("Host-native exec approvals can only target a node.");
    }
    await callGatewayFromCli("exec.approvals.node.set", params.opts, {
      nodeId: params.nodeId,
      native: params.native,
      baseHash: params.baseHash,
    });
    next = await loadSnapshot(params.opts, params.nodeId);
  } else if (params.source === "local") {
    next = await saveSnapshotLocal(params.file, params.baseHash);
  } else {
    next = await saveSnapshot(params.opts, params.nodeId, params.file, params.baseHash);
  }
  if (params.opts.json) {
    defaultRuntime.writeJson(next, 0);
    return;
  }
  defaultRuntime.log(theme.muted(`Target: ${params.targetLabel}`));
  renderApprovalsSnapshot(next, params.targetLabel);
}

function formatCliError(err: unknown): string {
  const msg = formatErrorMessage(err);
  const firstLine = msg.includes("\n") ? msg.split("\n")[0] : msg;
  const safe = sanitizeForLog(expectDefined(firstLine, "exec approvals cli first line"));
  return safe.length > 300 ? `${truncateUtf16Safe(safe, 300)}...` : safe;
}

function isApprovalDecision(value: string): value is ApprovalDecision {
  return (APPROVAL_DECISIONS as readonly string[]).includes(value);
}

function shortenPendingApprovalSummary(value: string): string {
  if (value.length <= PENDING_APPROVAL_SUMMARY_MAX_LENGTH) {
    return value;
  }
  return `${truncateUtf16Safe(value, PENDING_APPROVAL_SUMMARY_MAX_LENGTH - 3)}...`;
}

function escapeApprovalTextForTerminal(value: string): string {
  let escaped = "";
  for (const char of value) {
    if (char === "\\") {
      escaped += "\\\\";
      continue;
    }
    if (APPROVAL_TERMINAL_UNSAFE_CHAR.test(char)) {
      escaped += `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
      continue;
    }
    escaped += char;
  }
  return escaped;
}

// Gateway-minted ids are UUID-shaped, but explicit ids from an agent host are
// stored verbatim, so hostile ids (ANSI escapes, controls) are possible. Show
// the raw id when it is terminal-safe; wrap only unsafe ids in a copyable
// token that `resolve` decodes.
// Leading hyphen excluded: a raw `-x`/`--flag` id could not be pasted into
// `approvals resolve <id>` without Commander eating it as an option.
const APPROVAL_ID_TERMINAL_SAFE_RE = /^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,127}$/;

// Tokens encode UTF-16 code units, not UTF-8: ids are opaque JS strings and
// UTF-8 replaces lone surrogates with U+FFFD, which would let two distinct
// ids collide into one token on this remote-execution surface.
function formatApprovalIdForTerminal(value: string): string {
  if (APPROVAL_ID_TERMINAL_SAFE_RE.test(value)) {
    return value;
  }
  return `${APPROVAL_ID_TOKEN_PREFIX}${Buffer.from(value, "utf16le").toString("base64url")}`;
}

function decodeDisplayedApprovalId(value: string): string | null {
  if (!value.startsWith(APPROVAL_ID_TOKEN_PREFIX)) {
    return null;
  }
  const encoded = value.slice(APPROVAL_ID_TOKEN_PREFIX.length);
  if (!encoded || !/^[a-zA-Z0-9_-]+$/.test(encoded)) {
    return null;
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf16le");
  return Buffer.from(decoded, "utf16le").toString("base64url") === encoded ? decoded : null;
}

function readPendingApprovalEntry(
  value: unknown,
  kind: ApprovalKind,
): PendingApprovalCliEntry | null {
  if (!isRecord(value) || !isRecord(value.request)) {
    return null;
  }
  // Approval ids are opaque and stored verbatim by the gateway — never trim
  // them, or two ids differing only in whitespace collapse into one display
  // form and resolving could target the wrong request. Whitespace-bearing ids
  // fail the terminal-safe charset and render as exact-round-trip id64 tokens.
  // Ill-formed (lone-surrogate) ids are skipped outright: the unified
  // approval.get/resolve schema rejects them, so listing one would advertise
  // a token that can never be resolved.
  const id = typeof value.id === "string" && isWellFormedApprovalId(value.id) ? value.id : null;
  const createdAtMs = value.createdAtMs;
  const expiresAtMs = value.expiresAtMs;
  if (
    !id ||
    typeof createdAtMs !== "number" ||
    !Number.isFinite(createdAtMs) ||
    typeof expiresAtMs !== "number" ||
    !Number.isFinite(expiresAtMs)
  ) {
    return null;
  }
  const request = value.request;
  const agentId = normalizeOptionalString(request.agentId) ?? null;
  const sessionKey = normalizeOptionalString(request.sessionKey) ?? null;
  const command = typeof request.command === "string" && request.command ? request.command : null;
  const title = typeof request.title === "string" && request.title ? request.title : null;
  const description =
    typeof request.description === "string" && request.description ? request.description : null;
  const prose = title && description ? `${title}: ${description}` : (title ?? description);
  // System-agent approvals stay on their reviewer-safe presentation (title,
  // description); the raw operation is host-local by contract and must not
  // leak into terminals, scripts, or logs.
  const summarySource =
    kind === "exec"
      ? command
      : kind === "plugin" && command
        ? `${prose ? `${prose} — ` : ""}Command: ${command}`
        : prose;
  return {
    id,
    kind,
    agentId,
    sessionKey,
    createdAtMs,
    expiresAtMs,
    summary: summarySource ?? "(summary unavailable)",
  };
}

function readPendingApprovalList(value: unknown, kind: ApprovalKind): PendingApprovalCliEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${kind} approval list response.`);
  }
  return value.flatMap((entry) => {
    const parsed = readPendingApprovalEntry(entry, kind);
    return parsed ? [parsed] : [];
  });
}

async function loadPendingApprovals(
  opts: ExecApprovalsCliOpts,
): Promise<PendingApprovalCliEntry[]> {
  // The owner-specific list methods retain requester filtering unless the caller is an admin.
  // Request admin explicitly so this operator command cannot silently omit live approvals.
  const listCall = (method: string) =>
    callGatewayFromCli(method, opts, {}, { scopes: [ADMIN_SCOPE] });
  const [exec, plugin, systemAgent] = await Promise.all([
    listCall("exec.approval.list"),
    listCall("plugin.approval.list"),
    listCall("openclaw.approval.list"),
  ]);
  return [
    ...readPendingApprovalList(exec, "exec"),
    ...readPendingApprovalList(plugin, "plugin"),
    ...readPendingApprovalList(systemAgent, "system-agent"),
  ].toSorted((a, b) => b.createdAtMs - a.createdAtMs);
}

function formatPendingAgentSession(entry: PendingApprovalCliEntry): string {
  const parts = [entry.agentId, entry.sessionKey].filter((value): value is string =>
    Boolean(value),
  );
  return parts.length > 0 ? escapeApprovalTextForTerminal(parts.join(" / ")) : "-";
}

function renderPendingApprovals(entries: PendingApprovalCliEntry[]): void {
  if (entries.length === 0) {
    defaultRuntime.log(theme.muted("No pending approvals."));
    return;
  }
  const now = Date.now();
  defaultRuntime.log(`${theme.heading("Pending approvals")} ${theme.muted(`(${entries.length})`)}`);
  defaultRuntime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "ID", header: "ID", minWidth: 16, flex: true },
        { key: "Kind", header: "Kind", minWidth: 12 },
        { key: "AgentSession", header: "Agent / Session", minWidth: 16, flex: true },
        { key: "Requested", header: "Requested", minWidth: 12 },
        { key: "Expires", header: "Expires In", minWidth: 10 },
        { key: "Summary", header: "Command / Summary", minWidth: 20, flex: true },
      ],
      rows: entries.map((entry) => {
        const summary = escapeApprovalTextForTerminal(entry.summary);
        return {
          ID: formatApprovalIdForTerminal(entry.id),
          Kind: entry.kind,
          AgentSession: formatPendingAgentSession(entry),
          Requested: formatTimeAgo(Math.max(0, now - entry.createdAtMs)),
          Expires: formatTimeAgo(Math.max(0, entry.expiresAtMs - now), { suffix: false }),
          Summary: shortenPendingApprovalSummary(summary),
        };
      }),
    }).trimEnd(),
  );
  defaultRuntime.log(theme.heading("Full request text"));
  for (const entry of entries) {
    defaultRuntime.log(
      `${formatApprovalIdForTerminal(entry.id)}: ${escapeApprovalTextForTerminal(entry.summary)}`,
    );
  }
}

function approvalRecordedDecision(approval: ApprovalSnapshot): ApprovalDecision | null {
  return "decision" in approval && isApprovalDecision(approval.decision) ? approval.decision : null;
}

function formatResolver(approval: ApprovalResolveResult["approval"]): string {
  const resolver = approval.resolver;
  if (!resolver) {
    return "unknown resolver";
  }
  return resolver.id
    ? `${resolver.kind}:${escapeApprovalTextForTerminal(resolver.id)}`
    : resolver.kind;
}

function describeTerminalApprovalFailure(approval: ApprovalResolveResult["approval"]): string {
  const id = formatApprovalIdForTerminal(approval.id);
  if (approval.status === "expired") {
    return `Approval ${id} expired.`;
  }
  if (approval.status === "cancelled") {
    return `Approval ${id} was cancelled (${approval.reason}).`;
  }
  return `Approval ${id} did not settle to a recorded decision.`;
}

async function resolvePendingApproval(
  idInput: string,
  decisionInput: string,
  opts: ExecApprovalsCliOpts,
): Promise<void> {
  // Never trim the id: `pending --json` emits ids verbatim, and a
  // whitespace-bearing id fed back through a script must target exactly that
  // approval, not its trimmed sibling.
  if (idInput.length === 0) {
    exitWithError("Approval id required.");
  }
  const rawId = idInput;
  const decision = requireTrimmedNonEmpty(decisionInput, "Decision required.");
  if (!isApprovalDecision(decision)) {
    exitWithError(`Decision must be one of: ${APPROVAL_DECISIONS.join(", ")}.`);
  }
  const reason = opts.reason === undefined ? null : normalizeOptionalString(opts.reason);
  if (opts.reason !== undefined && !reason) {
    exitWithError("Reason must not be empty.");
  }

  // No explicit device identity: operator.admin authorizes resolution on its
  // own (canReviewOperatorApproval), and forcing a local identity onto a
  // loopback token/password session can trigger pairing for an otherwise
  // authorized credential.
  const approvalCallOptions = {
    scopes: [ADMIN_SCOPE, APPROVALS_SCOPE] as OperatorScope[],
  };

  const lookupOne = async (id: string, tolerateNotFound = false) => {
    try {
      return (await callGatewayFromCli(
        "approval.get",
        opts,
        { id },
        approvalCallOptions,
      )) as ApprovalGetResult;
    } catch (error) {
      if (
        tolerateNotFound &&
        formatErrorMessage(error).toLowerCase().includes("approval not found")
      ) {
        return null;
      }
      throw error;
    }
  };

  const decodedId = decodeDisplayedApprovalId(rawId);
  let id = rawId;
  let lookup: ApprovalGetResult;
  if (decodedId && decodedId !== rawId) {
    const [rawLookup, decodedLookup] = await Promise.all([
      lookupOne(rawId, true),
      lookupOne(decodedId, true),
    ]);
    if (rawLookup && decodedLookup) {
      exitWithError(
        "Approval id is ambiguous: it matches both a raw id and a displayed id token. This CLI cannot resolve it safely.",
      );
    }
    if (rawLookup) {
      lookup = rawLookup;
    } else if (decodedLookup) {
      id = decodedId;
      lookup = decodedLookup;
    } else {
      exitWithError("Approval not found.");
    }
  } else {
    lookup = expectDefined(await lookupOne(rawId), "approval lookup result");
  }
  const displayId = formatApprovalIdForTerminal(id);
  const current = lookup.approval;
  if (current.status === "pending") {
    const allowedDecisions = current.presentation.allowedDecisions as readonly ApprovalDecision[];
    if (!allowedDecisions.includes(decision)) {
      exitWithError(
        `Decision ${decision} is not allowed for ${current.presentation.kind} approvals; allowed decisions: ${allowedDecisions.join(", ")}.`,
      );
    }
  }

  const result = (await callGatewayFromCli(
    "approval.resolve",
    opts,
    {
      id,
      kind: current.presentation.kind,
      decision,
    },
    approvalCallOptions,
  )) as ApprovalResolveResult;
  const recordedDecision = approvalRecordedDecision(result.approval);
  if (!recordedDecision) {
    exitWithError(describeTerminalApprovalFailure(result.approval));
  }
  if (recordedDecision !== decision) {
    exitWithError(
      `Approval ${displayId} was already resolved with ${recordedDecision} by ${formatResolver(result.approval)}.`,
    );
  }

  if (opts.json) {
    defaultRuntime.writeJson(
      {
        ...result,
        alreadyResolved: !result.applied,
        ...(reason ? { cliReason: reason } : {}),
      },
      0,
    );
    return;
  }
  const settled = result.applied
    ? `resolved ${recordedDecision}`
    : `already resolved (same decision: ${recordedDecision})`;
  const reasonSuffix = reason
    ? `; CLI reason: ${shortenPendingApprovalSummary(escapeApprovalTextForTerminal(reason))}`
    : "";
  defaultRuntime.log(
    `Approval ${displayId} ${settled} by ${formatResolver(result.approval)}${reasonSuffix}.`,
  );
}

async function loadConfigForApprovalsTarget(params: {
  opts: ExecApprovalsCliOpts;
  source: ApprovalsTargetSource;
}): Promise<ConfigLoadResult> {
  try {
    if (params.source === "local") {
      return { config: await readBestEffortConfig(), timedOut: false };
    }
    const snapshot = (await callGatewayFromCli(
      "config.get",
      params.opts,
      {},
    )) as ConfigSnapshotLike;
    return {
      config: snapshot.config && typeof snapshot.config === "object" ? snapshot.config : null,
      timedOut: false,
    };
  } catch (err) {
    return {
      config: null,
      timedOut: /^gateway timeout after \d+ms\b/i.test(formatCliError(err)),
    };
  }
}

function buildEffectivePolicyReport(params: {
  configLoad: ConfigLoadResult;
  source: ApprovalsTargetSource;
  approvals?: ExecApprovalsFile;
  resolvedDefaults?: Required<ExecApprovalsDefaults>;
  hostPath: string;
  nativePolicy: boolean;
}): EffectivePolicyReport {
  const cfg = params.configLoad.config;
  const timeoutNote = params.configLoad.timedOut
    ? "Config fetch timed out. Re-run with a higher --timeout to inspect Effective Policy."
    : null;
  if (!params.approvals) {
    return {
      scopes: [],
      note: params.nativePolicy
        ? "This node enforces a host-native exec policy; OpenClaw approvals-file policy math does not apply."
        : "Approvals file unavailable.",
    };
  }
  if (params.source === "node") {
    if (!cfg) {
      return {
        scopes: [],
        note:
          timeoutNote ??
          "Gateway config unavailable. Node output above shows host approvals state only, and final runtime policy still intersects with gateway tools.exec.",
      };
    }
    if (!params.resolvedDefaults) {
      return {
        scopes: [],
        note: "This node does not expose a complete resolved host policy, so Effective Policy is unavailable.",
      };
    }
    return {
      scopes: collectExecPolicyScopeSnapshots({
        cfg,
        approvals: params.approvals,
        hostPath: params.hostPath,
        hostDefaults: params.resolvedDefaults,
        hostDefaultSource: "node-reported resolved defaults",
      }),
      note:
        "Effective exec policy is the node host approvals file intersected with gateway tools.exec policy. " +
        SESSION_EXEC_OVERRIDES_NOTE,
    };
  }
  if (!cfg) {
    return {
      scopes: [],
      note: timeoutNote ?? "Config unavailable.",
    };
  }
  return {
    scopes: collectExecPolicyScopeSnapshots({
      cfg,
      approvals: params.approvals,
      hostPath: params.hostPath,
    }),
    note:
      "Effective exec policy is the host approvals file intersected with requested tools.exec policy. " +
      SESSION_EXEC_OVERRIDES_NOTE,
  };
}

function renderEffectivePolicy(params: { report: EffectivePolicyReport }) {
  const rich = isRich();
  const heading = (text: string) => (rich ? theme.heading(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);
  if (params.report.scopes.length === 0 && !params.report.note) {
    return;
  }
  defaultRuntime.log("");
  defaultRuntime.log(heading("Effective Policy"));
  if (params.report.scopes.length === 0) {
    defaultRuntime.log(muted(params.report.note ?? "No effective policy details available."));
    return;
  }
  const rows = params.report.scopes.map((summary) => ({
    Scope: summary.scopeLabel,
    Requested: `security=${summary.security.requested} (${summary.security.requestedSource})\nask=${summary.ask.requested} (${summary.ask.requestedSource})`,
    Host: `security=${summary.security.host} (${summary.security.hostSource})\nask=${summary.ask.host} (${summary.ask.hostSource})\naskFallback=${summary.askFallback.effective} (${summary.askFallback.source})`,
    Effective: `security=${summary.security.effective}\nask=${summary.ask.effective}`,
    Notes: `${summary.security.note}; ${summary.ask.note}`,
  }));
  defaultRuntime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "Scope", header: "Scope", minWidth: 12 },
        { key: "Requested", header: "Requested", minWidth: 24, flex: true },
        { key: "Host", header: "Host", minWidth: 24, flex: true },
        { key: "Effective", header: "Effective", minWidth: 16 },
        { key: "Notes", header: "Notes", minWidth: 20, flex: true },
      ],
      rows,
    }).trimEnd(),
  );
  defaultRuntime.log("");
  defaultRuntime.log(muted(`Precedence: ${params.report.note}`));
}

function renderApprovalsSnapshot(snapshot: ExecApprovalsSnapshot, targetLabel: string) {
  if (isNativeApprovalsSnapshot(snapshot)) {
    renderNativeApprovalsSnapshot(snapshot, targetLabel);
    return;
  }
  const rich = isRich();
  const heading = (text: string) => (rich ? theme.heading(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);
  const tableWidth = getTerminalTableWidth();

  const file = snapshot.file ?? { version: 1 };
  const defaults = file.defaults ?? {};
  const defaultsParts = [
    defaults.security ? `security=${defaults.security}` : null,
    defaults.ask ? `ask=${defaults.ask}` : null,
    defaults.askFallback ? `askFallback=${defaults.askFallback}` : null,
    typeof defaults.autoAllowSkills === "boolean"
      ? `autoAllowSkills=${defaults.autoAllowSkills ? "on" : "off"}`
      : null,
  ].filter((part): part is string => part != null);
  const agents = file.agents ?? {};
  const allowlistRows: Array<{ Target: string; Agent: string; Pattern: string; LastUsed: string }> =
    [];
  const now = Date.now();
  for (const [agentId, agent] of Object.entries(agents)) {
    const allowlist = Array.isArray(agent.allowlist) ? agent.allowlist : [];
    for (const entry of allowlist) {
      const pattern = normalizeOptionalString(entry?.pattern) ?? "";
      if (!pattern) {
        continue;
      }
      const lastUsedAt = typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : null;
      allowlistRows.push({
        Target: targetLabel,
        Agent: agentId,
        Pattern: pattern,
        LastUsed: lastUsedAt ? formatTimeAgo(Math.max(0, now - lastUsedAt)) : muted("unknown"),
      });
    }
  }

  const summaryRows = [
    { Field: "Target", Value: targetLabel },
    { Field: "Path", Value: snapshot.path },
    { Field: "Exists", Value: snapshot.exists ? "yes" : "no" },
    { Field: "Hash", Value: snapshot.hash },
    { Field: "Version", Value: String(file.version ?? 1) },
    { Field: "Socket", Value: file.socket?.path ?? "default" },
    { Field: "Defaults", Value: defaultsParts.length > 0 ? defaultsParts.join(", ") : "none" },
    { Field: "Agents", Value: String(Object.keys(agents).length) },
    { Field: "Allowlist", Value: String(allowlistRows.length) },
  ];

  defaultRuntime.log(heading("Approvals"));
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Field", header: "Field", minWidth: 8 },
        { key: "Value", header: "Value", minWidth: 24, flex: true },
      ],
      rows: summaryRows,
    }).trimEnd(),
  );

  if (allowlistRows.length === 0) {
    defaultRuntime.log("");
    defaultRuntime.log(muted("No allowlist entries."));
    return;
  }

  defaultRuntime.log("");
  defaultRuntime.log(heading("Allowlist"));
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Target", header: "Target", minWidth: 10 },
        { key: "Agent", header: "Agent", minWidth: 8 },
        { key: "Pattern", header: "Pattern", minWidth: 20, flex: true },
        { key: "LastUsed", header: "Last Used", minWidth: 10 },
      ],
      rows: allowlistRows,
    }).trimEnd(),
  );
}

function renderNativeApprovalsSnapshot(snapshot: NativeExecApprovalsSnapshot, targetLabel: string) {
  const rich = isRich();
  const heading = (text: string) => (rich ? theme.heading(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);
  const rules = snapshot.enabled ? snapshot.rules : [];
  const summaryRows = [
    { Field: "Target", Value: targetLabel },
    { Field: "Kind", Value: "host-native" },
    { Field: "Enabled", Value: snapshot.enabled ? "yes" : "no" },
    { Field: "Hash", Value: snapshot.enabled ? snapshot.hash : "unavailable" },
    {
      Field: "Default",
      Value: snapshot.enabled ? snapshot.defaultAction : (snapshot.message ?? "unavailable"),
    },
    { Field: "Rules", Value: String(rules.length) },
  ];
  defaultRuntime.log(heading("Approvals"));
  defaultRuntime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "Field", header: "Field", minWidth: 8 },
        { key: "Value", header: "Value", minWidth: 24, flex: true },
      ],
      rows: summaryRows,
    }).trimEnd(),
  );
  if (rules.length === 0) {
    defaultRuntime.log("");
    defaultRuntime.log(muted("No host-native rules."));
    return;
  }
  defaultRuntime.log("");
  defaultRuntime.log(heading("Rules"));
  defaultRuntime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "Pattern", header: "Pattern", minWidth: 20, flex: true },
        { key: "Action", header: "Action", minWidth: 8 },
        { key: "Shells", header: "Shells", minWidth: 10, flex: true },
        { key: "Enabled", header: "Enabled", minWidth: 7 },
      ],
      rows: rules.map((rule) => ({
        Pattern: rule.pattern,
        Action: rule.action,
        Shells: rule.shells?.join(", ") || "all",
        Enabled: rule.enabled === false ? "no" : "yes",
      })),
    }).trimEnd(),
  );
}

async function saveSnapshot(
  opts: ExecApprovalsCliOpts,
  nodeId: string | null,
  file: ExecApprovalsFile,
  baseHash: string,
): Promise<ExecApprovalsSnapshot> {
  const method = nodeId ? "exec.approvals.node.set" : "exec.approvals.set";
  const params = nodeId ? { nodeId, file, baseHash } : { file, baseHash };
  const snapshot = (await callGatewayFromCli(method, opts, params)) as ExecApprovalsSnapshot;
  return snapshot;
}

function resolveAgentKey(value?: string | null): string {
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed ? trimmed : "*";
}

function normalizeAllowlistEntry(entry: { pattern?: string } | null): string | null {
  const pattern = normalizeOptionalString(entry?.pattern) ?? "";
  return pattern ? pattern : null;
}

function ensureAgent(file: ExecApprovalsFile, agentKey: string): ExecApprovalsAgent {
  const agents = file.agents ?? {};
  const entry = agents[agentKey] ?? {};
  file.agents = agents;
  return entry;
}

function isEmptyAgent(agent: ExecApprovalsAgent): boolean {
  const allowlist = Array.isArray(agent.allowlist) ? agent.allowlist : [];
  return (
    !agent.security &&
    !agent.ask &&
    !agent.askFallback &&
    agent.autoAllowSkills === undefined &&
    allowlist.length === 0
  );
}

async function loadWritableAllowlistAgent(opts: ExecApprovalsCliOpts): Promise<{
  nodeId: string | null;
  source: "gateway" | "node" | "local";
  targetLabel: string;
  baseHash: string;
  file: ExecApprovalsFile;
  agentKey: string;
  agent: ExecApprovalsAgent;
  allowlistEntries: NonNullable<ExecApprovalsAgent["allowlist"]>;
}> {
  const { snapshot, nodeId, source, targetLabel, baseHash, kind } =
    await loadWritableSnapshotTarget(opts);
  if (kind === "native" || !isFileApprovalsSnapshot(snapshot)) {
    exitWithError(
      "Host-native node approvals do not support allowlist mutations; use approvals set --node with host-native JSON.",
    );
  }
  const file = snapshot.file;
  file.version = 1;

  const agentKey = resolveAgentKey(opts.agent);
  const agent = ensureAgent(file, agentKey);
  const allowlistEntries = Array.isArray(agent.allowlist) ? agent.allowlist : [];

  return { nodeId, source, targetLabel, baseHash, file, agentKey, agent, allowlistEntries };
}

type WritableAllowlistAgentContext = Awaited<ReturnType<typeof loadWritableAllowlistAgent>> & {
  trimmedPattern: string;
};
type AllowlistMutation = (context: WritableAllowlistAgentContext) => boolean | Promise<boolean>;

async function runAllowlistMutation(
  pattern: string,
  opts: ExecApprovalsCliOpts,
  mutate: AllowlistMutation,
): Promise<void> {
  try {
    const trimmedPattern = requireTrimmedNonEmpty(pattern, "Pattern required.");
    const context = await loadWritableAllowlistAgent(opts);
    const shouldSave = await mutate({ ...context, trimmedPattern });
    if (!shouldSave) {
      return;
    }
    await saveSnapshotTargeted({
      opts,
      source: context.source,
      nodeId: context.nodeId,
      file: context.file,
      baseHash: context.baseHash,
      targetLabel: context.targetLabel,
    });
  } catch (err) {
    defaultRuntime.error(formatCliError(err));
    defaultRuntime.exit(1);
  }
}

function registerAllowlistMutationCommand(params: {
  allowlist: Command;
  name: "add" | "remove";
  description: string;
  mutate: AllowlistMutation;
}): Command {
  const command = params.allowlist
    .command(`${params.name} <pattern>`)
    .description(params.description)
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .option("--agent <id>", 'Agent id (defaults to "*")')
    .action(async (pattern: string, opts: ExecApprovalsCliOpts) => {
      await runAllowlistMutation(pattern, opts, params.mutate);
    });
  nodesCallOpts(command);
  return command;
}

export function registerExecApprovalsCli(program: Command) {
  const formatExample = (cmd: string, desc: string) =>
    `  ${theme.command(cmd)}\n    ${theme.muted(desc)}`;

  const approvals = program
    .command("approvals")
    .alias("exec-approvals")
    .description("Manage approval policy and pending requests")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals", "docs.openclaw.ai/cli/approvals")}\n`,
    );

  const pendingCmd = approvals
    .command("pending")
    .description("List pending exec, plugin, and system-agent approvals")
    .action(async (opts: ExecApprovalsCliOpts) => {
      try {
        const entries = await loadPendingApprovals(opts);
        if (opts.json) {
          defaultRuntime.writeJson({ approvals: entries }, 0);
          return;
        }
        renderPendingApprovals(entries);
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(pendingCmd);

  const resolveCmd = approvals
    .command("resolve <id> <decision>")
    .description("Resolve a pending approval")
    .option("--reason <text>", "Add a local note to the CLI confirmation")
    .action(async (id: string, decision: string, opts: ExecApprovalsCliOpts) => {
      try {
        await resolvePendingApproval(id, decision, opts);
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(resolveCmd);

  const getCmd = approvals
    .command("get")
    .description("Fetch exec approvals snapshot")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .action(async (opts: ExecApprovalsCliOpts) => {
      try {
        const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
        const nativePolicy = isNativeApprovalsSnapshot(snapshot);
        const configLoad = nativePolicy
          ? { config: null, timedOut: false }
          : await loadConfigForApprovalsTarget({ opts, source });
        const fileSnapshot = isFileApprovalsSnapshot(snapshot) ? snapshot : null;
        const effectivePolicy = buildEffectivePolicyReport({
          configLoad,
          source,
          approvals: fileSnapshot?.file,
          resolvedDefaults: fileSnapshot?.resolvedDefaults,
          hostPath: fileSnapshot?.path ?? "",
          nativePolicy,
        });
        if (opts.json) {
          defaultRuntime.writeJson({ ...snapshot, effectivePolicy }, 0);
          return;
        }

        const muted = (text: string) => (isRich() ? theme.muted(text) : text);
        if (source === "local") {
          defaultRuntime.log(muted("Showing local approvals."));
          defaultRuntime.log("");
        }
        const targetLabel = source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway";
        renderApprovalsSnapshot(snapshot, targetLabel);
        renderEffectivePolicy({ report: effectivePolicy });
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(getCmd, { timeoutMs: APPROVALS_GET_DEFAULT_TIMEOUT_MS });

  const setCmd = approvals
    .command("set")
    .description("Replace exec approvals with a JSON file")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .option("--file <path>", "Path to JSON file to upload")
    .option("--stdin", "Read JSON from stdin", false)
    .action(async (opts: ExecApprovalsCliOpts) => {
      try {
        if (!opts.file && !opts.stdin) {
          exitWithError("Provide --file or --stdin.");
        }
        if (opts.file && opts.stdin) {
          exitWithError("Use either --file or --stdin (not both).");
        }
        const { source, nodeId, targetLabel, baseHash, kind } =
          await loadWritableSnapshotTarget(opts);
        const raw = opts.stdin ? await readStdin() : await readApprovalsFile(String(opts.file));
        let input: unknown;
        try {
          input = JSON5.parse(raw);
        } catch (err) {
          exitWithError(`Failed to parse approvals JSON: ${String(err)}`);
        }
        if (kind === "native") {
          const native = normalizeNativePolicyInput(input);
          await saveSnapshotTargeted({
            opts,
            source,
            nodeId,
            native,
            baseHash,
            targetLabel,
          });
          return;
        }
        if (!isRecord(input)) {
          exitWithError("Exec approvals JSON must be an object.");
        }
        const file = input as ExecApprovalsFile;
        file.version = 1;
        await saveSnapshotTargeted({ opts, source, nodeId, file, baseHash, targetLabel });
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(setCmd);

  const allowlist = approvals
    .command("allowlist")
    .description("Edit the per-agent allowlist")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatExample(
          'openclaw approvals allowlist add "~/Projects/**/bin/rg"',
          "Allowlist a local binary pattern for the main agent.",
        )}\n${formatExample(
          'openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"',
          "Allowlist on a specific node/agent.",
        )}\n${formatExample(
          'openclaw approvals allowlist add --agent "*" "/usr/bin/uname"',
          "Allowlist for all agents (wildcard).",
        )}\n${formatExample(
          'openclaw approvals allowlist remove "~/Projects/**/bin/rg"',
          "Remove an allowlist pattern.",
        )}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals", "docs.openclaw.ai/cli/approvals")}\n`,
    );

  registerAllowlistMutationCommand({
    allowlist,
    name: "add",
    description: "Add a glob pattern to an allowlist",
    mutate: ({ trimmedPattern, file, agent, agentKey, allowlistEntries }) => {
      if (allowlistEntries.some((entry) => normalizeAllowlistEntry(entry) === trimmedPattern)) {
        defaultRuntime.log("Already allowlisted.");
        return false;
      }
      allowlistEntries.push({ pattern: trimmedPattern, lastUsedAt: Date.now() });
      agent.allowlist = allowlistEntries;
      file.agents = { ...file.agents, [agentKey]: agent };
      return true;
    },
  });

  registerAllowlistMutationCommand({
    allowlist,
    name: "remove",
    description: "Remove a glob pattern from an allowlist",
    mutate: ({ trimmedPattern, file, agent, agentKey, allowlistEntries }) => {
      const nextEntries = allowlistEntries.filter(
        (entry) => normalizeAllowlistEntry(entry) !== trimmedPattern,
      );
      if (nextEntries.length === allowlistEntries.length) {
        defaultRuntime.log("Pattern not found.");
        return false;
      }
      if (nextEntries.length === 0) {
        delete agent.allowlist;
      } else {
        agent.allowlist = nextEntries;
      }
      if (isEmptyAgent(agent)) {
        const agents = { ...file.agents };
        delete agents[agentKey];
        file.agents = Object.keys(agents).length > 0 ? agents : undefined;
      } else {
        file.agents = { ...file.agents, [agentKey]: agent };
      }
      return true;
    },
  });

  applyParentDefaultHelpAction(approvals);
}

export const testing = {
  formatCliError,
  readStdin,
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
