/** Evaluates node-host exec policy from security, approval, and allowlist context. */
import { requiresExecApproval, type ExecAsk, type ExecSecurity } from "../infra/exec-approvals.js";

type ExecApprovalDecision = "allow-once" | "allow-always" | null;

type SystemRunPolicyDecision = {
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  shellWrapperBlocked: boolean;
  windowsShellWrapperBlocked: boolean;
  requiresAsk: boolean;
  approvalDecision: ExecApprovalDecision;
  approvedByAsk: boolean;
} & (
  | {
      allowed: true;
    }
  | {
      allowed: false;
      eventReason: "security=deny" | "denylist-hit" | "approval-required" | "allowlist-miss";
      errorMessage: string;
    }
);

/** Normalizes raw approval decisions from node-host payloads. */
export function resolveExecApprovalDecision(value: unknown): ExecApprovalDecision {
  if (value === "allow-once" || value === "allow-always") {
    return value;
  }
  return null;
}

function formatSystemRunAllowlistMissMessage(params?: {
  windowsShellWrapperBlocked?: boolean;
}): string {
  if (params?.windowsShellWrapperBlocked) {
    return (
      "SYSTEM_RUN_DENIED: allowlist miss " +
      "(Windows shell wrappers like cmd.exe /c require approval; " +
      "approve once/always or run with --ask on-miss|always)"
    );
  }
  return "SYSTEM_RUN_DENIED: allowlist miss";
}

/** Combines exec security, allowlist analysis, and approval state into an allow/deny decision. */
export function evaluateSystemRunPolicy(params: {
  security: ExecSecurity;
  ask: ExecAsk;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied?: boolean;
  approvalDecision: ExecApprovalDecision;
  approved?: boolean;
  isWindows: boolean;
  cmdInvocation: boolean;
  shellWrapperInvocation: boolean;
  /**
   * True when the command matches the effective exec denylist. Deny wins over
   * allow: it is evaluated right after `security=deny`, ahead of the allowlist
   * and ask paths, and is cleared only by an explicit approval decision.
   */
  denylisted?: boolean;
  /** Human-readable pattern/reason for the denylist hit, for the deny message. */
  denylistReason?: string | null;
}): SystemRunPolicyDecision {
  // POSIX node execution intentionally uses `/bin/sh -lc` as a transport wrapper.
  // Keep allowlist decisions based on the analyzed inner shell payload there.
  // Windows `cmd.exe /c` wrappers still require explicit approval because they
  // change execution semantics for builtins and quoting/parsing behavior.
  const windowsShellWrapperBlocked =
    params.security === "allowlist" &&
    params.shellWrapperInvocation &&
    params.isWindows &&
    params.cmdInvocation;
  const shellWrapperBlocked = windowsShellWrapperBlocked;
  const analysisOk = shellWrapperBlocked ? false : params.analysisOk;
  const allowlistSatisfied = shellWrapperBlocked ? false : params.allowlistSatisfied;
  const approvedByAsk = params.approvalDecision !== null || params.approved === true;

  if (params.security === "deny") {
    return {
      allowed: false,
      eventReason: "security=deny",
      errorMessage: "SYSTEM_RUN_DISABLED: security=deny",
      analysisOk,
      allowlistSatisfied,
      shellWrapperBlocked,
      windowsShellWrapperBlocked,
      requiresAsk: false,
      approvalDecision: params.approvalDecision,
      approvedByAsk,
    };
  }

  // Denylist wins over allow. A hit denies unless an explicit approval decision
  // clears it (durable allowlist trust does NOT clear a denylist hit).
  if (params.denylisted === true && !approvedByAsk) {
    const reason = params.denylistReason ? ` (${params.denylistReason})` : "";
    return {
      allowed: false,
      eventReason: "denylist-hit",
      errorMessage: `SYSTEM_RUN_DENIED: command matches exec denylist${reason}; explicit approval required`,
      analysisOk,
      allowlistSatisfied,
      shellWrapperBlocked,
      windowsShellWrapperBlocked,
      requiresAsk: true,
      approvalDecision: params.approvalDecision,
      approvedByAsk,
    };
  }

  const requiresAsk = requiresExecApproval({
    ask: params.ask,
    security: params.security,
    analysisOk,
    allowlistSatisfied,
    durableApprovalSatisfied: params.durableApprovalSatisfied,
    denylisted: params.denylisted,
  });
  if (requiresAsk && !approvedByAsk) {
    return {
      allowed: false,
      eventReason: "approval-required",
      errorMessage: "SYSTEM_RUN_DENIED: approval required",
      analysisOk,
      allowlistSatisfied,
      shellWrapperBlocked,
      windowsShellWrapperBlocked,
      requiresAsk,
      approvalDecision: params.approvalDecision,
      approvedByAsk,
    };
  }

  if (params.security === "allowlist" && (!analysisOk || !allowlistSatisfied) && !approvedByAsk) {
    if (params.durableApprovalSatisfied) {
      return {
        allowed: true,
        analysisOk,
        allowlistSatisfied,
        shellWrapperBlocked,
        windowsShellWrapperBlocked,
        requiresAsk,
        approvalDecision: params.approvalDecision,
        approvedByAsk,
      };
    }
    return {
      allowed: false,
      eventReason: "allowlist-miss",
      errorMessage: formatSystemRunAllowlistMissMessage({
        windowsShellWrapperBlocked,
      }),
      analysisOk,
      allowlistSatisfied,
      shellWrapperBlocked,
      windowsShellWrapperBlocked,
      requiresAsk,
      approvalDecision: params.approvalDecision,
      approvedByAsk,
    };
  }

  return {
    allowed: true,
    analysisOk,
    allowlistSatisfied,
    shellWrapperBlocked,
    windowsShellWrapperBlocked,
    requiresAsk,
    approvalDecision: params.approvalDecision,
    approvedByAsk,
  };
}
