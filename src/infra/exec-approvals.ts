// Manages exec approval policy, allowlist entries, and host targeting.
import {
  normalizeExecApprovalsInternal,
  resolveExecApprovalsPath,
  resolveExecApprovalsSocketPath,
} from "./exec-approvals-config.js";
import type { ExecApprovalsDefaultOverrides } from "./exec-approvals-contracts.js";
import type { ExecApprovalsFile, ExecApprovalsResolved } from "./exec-approvals-core.js";
import { withExecApprovalsReadLock, withExecApprovalsReadLockSync } from "./exec-approvals-lock.js";
import { resolveExecApprovalsFromFilePrepared } from "./exec-approvals-resolver.js";
import {
  ensureExecApprovals,
  ensureExecApprovalsSnapshot,
  readExecApprovalsForNoPersistenceUnlocked,
} from "./exec-approvals-store.js";
import { expandHomePrefix } from "./home-dir.js";

export * from "./exec-approvals-analysis.js";
export * from "./exec-approvals-allowlist.js";
export * from "./exec-approvals-core.js";
export type { ExecApprovalPolicySnapshot } from "./exec-approval-policy-snapshot.js";
export type { ExecAllowlistEntry } from "./exec-approvals.types.js";
export type { ExecApprovalsDefaultOverrides } from "./exec-approvals-contracts.js";
export {
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  mergeExecApprovalsSocketDefaults,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsPath,
  resolveExecApprovalsSocketPath,
  resolveExecApprovalsTranscriptPath,
} from "./exec-approvals-config.js";
export {
  ensureExecApprovals,
  ensureExecApprovalsSnapshot,
  loadExecApprovals,
  loadExecApprovalsAsync,
  readExecApprovalsSnapshot,
  restoreExecApprovalsSnapshot,
  restoreExecApprovalsSnapshotLocked,
  saveExecApprovals,
  updateExecApprovals,
  withAgentExecApprovalsRemoved,
} from "./exec-approvals-store.js";

export function normalizeExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  const token = file.socket?.token?.trim();
  return normalizeExecApprovalsInternal({
    ...file,
    socket: { path: socketPath, token },
  });
}

function shapeResolvedExecApprovals(params: {
  file: ExecApprovalsFile;
  filePath: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  socket: "none" | "persisted";
}): ExecApprovalsResolved {
  const defaultSocketPath = resolveExecApprovalsSocketPath();
  return resolveExecApprovalsFromFile({
    file: params.file,
    agentId: params.agentId,
    overrides: params.overrides,
    path: params.filePath,
    socketPath:
      params.socket === "persisted"
        ? expandHomePrefix(params.file.socket?.path ?? defaultSocketPath)
        : defaultSocketPath,
    token: params.socket === "persisted" ? (params.file.socket?.token ?? "") : "",
  });
}

function resolveExecApprovalsWithoutSocket(params: {
  file: ExecApprovalsFile;
  filePath: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
}): ExecApprovalsResolved | null {
  const resolved = shapeResolvedExecApprovals({ ...params, socket: "none" });
  const noPrompt =
    (resolved.agent.security === "full" || resolved.agent.security === "deny") &&
    resolved.agent.ask === "off";
  return noPrompt && !params.file.socket?.token?.trim() ? resolved : null;
}

export function resolveExecApprovals(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): ExecApprovalsResolved {
  const filePath = resolveExecApprovalsPath();
  if (!overrides?.requireSocket) {
    const file = withExecApprovalsReadLockSync(filePath, () =>
      readExecApprovalsForNoPersistenceUnlocked(filePath),
    );
    const resolved = resolveExecApprovalsWithoutSocket({
      file,
      filePath,
      agentId,
      overrides,
    });
    if (resolved) {
      return resolved;
    }
  }
  const file = ensureExecApprovals();
  return shapeResolvedExecApprovals({
    file,
    filePath,
    agentId,
    overrides,
    socket: "persisted",
  });
}

export async function resolveExecApprovalsLocked(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): Promise<ExecApprovalsResolved> {
  const filePath = resolveExecApprovalsPath();
  if (!overrides?.requireSocket) {
    const file = await withExecApprovalsReadLock(filePath, async () =>
      readExecApprovalsForNoPersistenceUnlocked(filePath),
    );
    const resolved = resolveExecApprovalsWithoutSocket({
      file,
      filePath,
      agentId,
      overrides,
    });
    if (resolved) {
      return resolved;
    }
  }
  return shapeResolvedExecApprovals({
    file: (await ensureExecApprovalsSnapshot()).file,
    filePath: resolveExecApprovalsPath(),
    agentId,
    overrides,
    socket: "persisted",
  });
}

export function resolveExecApprovalsFromFile(params: {
  file: ExecApprovalsFile;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
  token?: string;
}): ExecApprovalsResolved {
  const rawFile = params.file;
  const file = normalizeExecApprovals(params.file);
  return resolveExecApprovalsFromFilePrepared({
    ...params,
    rawFile,
    file,
    token: params.token ?? file.socket?.token ?? "",
  });
}

export {
  DEFAULT_EXEC_APPROVAL_DECISIONS,
  OPTIONAL_EXEC_APPROVAL_DECISIONS,
} from "./exec-approvals-policy.js";
export {
  commandRequiresSecurityAuditSuppressionApproval,
  isExecApprovalDecisionAllowed,
  maxAsk,
  minSecurity,
  normalizeExecApprovalUnavailableDecisions,
  requiresExecApproval,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalRequestAllowedDecisions,
  resolveExecApprovalUnavailableDecisions,
} from "./exec-approvals-policy.js";
export {
  addAllowlistEntry,
  addDurableCommandApproval,
  createExecApprovalPolicySnapshot,
  hasDurableExecApproval,
  hasExactCommandDurableExecApproval,
  hasNodeCommandAllowAlwaysMarker,
  isExecApprovalPolicySnapshotCurrent,
  persistAllowAlwaysDecision,
  persistAllowAlwaysPatterns,
  resolveAllowAlwaysPatternCoverage,
  resolveAllowAlwaysPersistenceDecision,
  resolveDurableExecApprovalRequirement,
} from "./exec-approvals-allow-always.js";
export type {
  AllowAlwaysPersistenceDecision,
  AllowAlwaysPersistenceReason,
} from "./exec-approvals-contracts.js";
export {
  commitExecAuthorizationLocked,
  recordAllowlistMatchesUse,
  recordAllowlistUse,
} from "./exec-approvals-authorization.js";
export type { ExecApprovalUsageAuthorization } from "./exec-approvals-authorization.js";
export { requestExecApprovalViaSocket } from "./exec-approvals-socket.js";
