// Revalidates and commits exec authority against the current policy.
import type { ExecApprovalPolicySnapshot } from "./exec-approval-policy-snapshot.js";
import {
  applyAllowAlwaysDecision,
  buildAllowlistEntryMatchKey,
  createExecApprovalPolicySnapshot,
  hasExactCommandDurableExecApproval,
  isExecApprovalPolicySnapshotCurrent,
} from "./exec-approvals-allow-always.js";
import type { AllowAlwaysPersistenceDecision } from "./exec-approvals-contracts.js";
import type { ExecApprovalsFile, ExecAsk, ExecSecurity } from "./exec-approvals-core.js";
import { maxAsk, minSecurity } from "./exec-approvals-policy.js";
import { resolveExecApprovalsFromFileInternal } from "./exec-approvals-resolver.js";
import {
  replaceExecApprovalsSnapshot,
  updateExecApprovals,
  updateExecApprovalsSync,
} from "./exec-approvals-store.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import { isGeneratedHashedArgPattern } from "./exec-command-resolution.js";

export type ExecApprovalUsageAuthorization = {
  source: "current-policy" | "ask-fallback" | "explicit-approval" | "auto-review";
  security: ExecSecurity;
  ask: ExecAsk;
  allowlistSatisfied: boolean;
  policySnapshot?: ExecApprovalPolicySnapshot;
  requireAutoAllowSkills?: boolean;
  requireExactCommandApproval?: boolean;
  requireDurableAllowlistApproval?: boolean;
};

function assertCurrentUsageAuthorization(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  command: string;
  matchKeys: ReadonlySet<string>;
  authorization: ExecApprovalUsageAuthorization;
}): void {
  const current = resolveExecApprovalsFromFileInternal({
    file: params.file,
    agentId: params.agentId,
    overrides: {
      security: params.authorization.security,
      ask: params.authorization.ask,
    },
  });
  const security = minSecurity(params.authorization.security, current.agent.security);
  const ask = maxAsk(params.authorization.ask, current.agent.ask);
  if (security === "deny") {
    throw new Error("Exec approval changed before execution");
  }
  // Human and model decisions are delayed authority. Bind both one-shot and
  // persistent decisions to the persisted policy they were evaluated against.
  const delayedAuthorization =
    params.authorization.source === "explicit-approval" ||
    params.authorization.source === "auto-review";
  if (delayedAuthorization) {
    const expectedPolicy = params.authorization.policySnapshot;
    if (
      !expectedPolicy ||
      !isExecApprovalPolicySnapshotCurrent(
        expectedPolicy,
        createExecApprovalPolicySnapshot({ file: params.file, agentId: params.agentId }),
      )
    ) {
      throw new Error("Exec approval changed before execution");
    }
  }
  if (params.authorization.source === "explicit-approval") {
    return;
  }
  if (params.authorization.source === "auto-review") {
    if (ask === "always") {
      throw new Error("Exec approval changed before execution");
    }
    return;
  }
  let authorizationSecurity = security;
  if (params.authorization.source === "ask-fallback") {
    const askFallback = minSecurity(security, current.agent.askFallback);
    // The execution plan was built for the evaluated fallback mode. If policy
    // tightened, fail closed instead of reusing a broader argv plan.
    if (askFallback === "deny" || askFallback !== params.authorization.security) {
      throw new Error("Exec approval changed before execution");
    }
    if (askFallback === "full") {
      return;
    }
    authorizationSecurity = askFallback;
  } else if (
    // A current-policy plan may only survive policy broadening. Tightening from
    // full to allowlist requires a newly bound command, not the stale raw plan.
    security !== params.authorization.security ||
    ask !== params.authorization.ask
  ) {
    throw new Error("Exec approval changed before execution");
  }
  if (authorizationSecurity !== "allowlist") {
    return;
  }
  if (params.authorization.requireExactCommandApproval) {
    if (
      !hasExactCommandDurableExecApproval({
        allowlist: current.allowlist,
        commandText: params.command,
      })
    ) {
      throw new Error("Exec approval changed before execution");
    }
    return;
  }
  if (params.authorization.requireDurableAllowlistApproval) {
    const durableKeys = new Set(
      current.allowlist
        .filter((entry) => entry.source === "allow-always")
        .map(buildAllowlistEntryMatchKey),
    );
    if (params.matchKeys.size === 0 || [...params.matchKeys].some((key) => !durableKeys.has(key))) {
      throw new Error("Exec approval changed before execution");
    }
  }
  if (!params.authorization.allowlistSatisfied) {
    throw new Error("Exec approval changed before execution");
  }
  const currentKeys = new Set(current.allowlist.map(buildAllowlistEntryMatchKey));
  if ([...params.matchKeys].some((key) => !currentKeys.has(key))) {
    throw new Error("Exec approval changed before execution");
  }
  if (params.authorization.requireAutoAllowSkills && !current.agent.autoAllowSkills) {
    throw new Error("Exec approval changed before execution");
  }
}

export function recordAllowlistUse(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  entry: ExecAllowlistEntry,
  command: string,
  resolvedPath?: string,
): void {
  recordAllowlistMatchesUse({
    approvals,
    agentId,
    matches: [entry],
    command,
    resolvedPath,
  });
}

export function recordAllowlistMatchesUse(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
  authorization?: ExecApprovalUsageAuthorization;
}): void {
  if (params.matches.length === 0 && !params.authorization) {
    return;
  }
  const snapshot = updateExecApprovalsSync({
    update: (file) => applyRecordedAllowlistUse({ ...params, file }),
  });
  if (snapshot) {
    replaceExecApprovalsSnapshot(params.approvals, snapshot.file);
  }
}

function applyRecordedAllowlistUse(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
  authorization?: ExecApprovalUsageAuthorization;
}): ExecApprovalsFile | null {
  const keys = new Set(
    params.matches.filter((entry) => entry.pattern).map(buildAllowlistEntryMatchKey),
  );
  if (params.authorization) {
    assertCurrentUsageAuthorization({
      file: params.file,
      agentId: params.agentId,
      command: params.command,
      matchKeys: keys,
      authorization: params.authorization,
    });
  }
  return applyRecordedAllowlistMetadata(params);
}

function applyRecordedAllowlistMetadata(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
}): ExecApprovalsFile | null {
  const keys = new Set(
    params.matches.filter((entry) => entry.pattern).map(buildAllowlistEntryMatchKey),
  );
  if (keys.size === 0) {
    return null;
  }
  if (!params.agentId) {
    throw new Error("Exec allowlist metadata update requires an explicit agent id.");
  }
  const target = params.agentId;
  const agents = params.file.agents ?? {};
  let changed = false;
  const nextAgents = { ...agents };
  for (const key of target === "*" ? [target] : ["*", target]) {
    const existing = agents[key];
    if (!existing?.allowlist) {
      continue;
    }
    let entryChanged = false;
    const nextAllowlist = existing.allowlist.map((entry) => {
      if (!keys.has(buildAllowlistEntryMatchKey(entry))) {
        return entry;
      }
      changed = true;
      entryChanged = true;
      return Object.assign({}, entry, {
        id: entry.id ?? crypto.randomUUID(),
        lastUsedAt: Date.now(),
        lastUsedCommand: isGeneratedHashedArgPattern(entry.argPattern) ? undefined : params.command,
        lastResolvedPath: params.resolvedPath,
      });
    });
    if (entryChanged) {
      nextAgents[key] = { ...existing, allowlist: nextAllowlist };
    }
  }
  return changed
    ? {
        ...params.file,
        agents: nextAgents,
      }
    : null;
}
export async function commitExecAuthorizationLocked(params: {
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
  authorization: ExecApprovalUsageAuthorization;
  allowAlwaysDecision?: AllowAlwaysPersistenceDecision;
}): Promise<void> {
  if (
    (params.authorization.source === "explicit-approval" ||
      params.authorization.source === "auto-review") &&
    !params.authorization.policySnapshot
  ) {
    throw new Error("Delayed exec authorization requires a policy snapshot");
  }
  if (params.allowAlwaysDecision && params.allowAlwaysDecision.kind !== "one-shot") {
    if (params.authorization.source !== "explicit-approval") {
      throw new Error("Allow-always persistence requires explicit approval");
    }
  }
  await updateExecApprovals({
    update: (file) => {
      const matchKeys = new Set(
        params.matches.filter((entry) => entry.pattern).map(buildAllowlistEntryMatchKey),
      );
      assertCurrentUsageAuthorization({
        file,
        agentId: params.agentId,
        command: params.command,
        matchKeys,
        authorization: params.authorization,
      });

      let next = file;
      let changed = false;
      if (params.allowAlwaysDecision && params.allowAlwaysDecision.kind !== "one-shot") {
        const granted = applyAllowAlwaysDecision({
          file: next,
          agentId: params.agentId,
          decision: params.allowAlwaysDecision,
        });
        if (granted) {
          next = granted;
          changed = true;
        }
      }
      const recorded = applyRecordedAllowlistMetadata({ ...params, file: next });
      return recorded ?? (changed ? next : null);
    },
  });
}
