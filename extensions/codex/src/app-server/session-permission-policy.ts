import { hostname as readHostName } from "node:os";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import type {
  CodexAppServerApprovalPolicy,
  CodexAppServerApprovalsReviewer,
  CodexAppServerRuntimeOptions,
  CodexAppServerSandboxMode,
  CodexPluginConfig,
  OpenClawExecMode,
} from "./config-contracts.js";
import { selectGuardianSandbox } from "./config-exec-policy.js";
import {
  parseAllowedApprovalPoliciesFromCodexRequirements,
  parseAllowedApprovalsReviewersFromCodexRequirements,
  parseAllowedSandboxModesFromCodexRequirements,
  selectGuardianApprovalPolicy,
  selectGuardianApprovalsReviewer,
  selectUserApprovalsReviewer,
} from "./config-requirements.js";
import { resolveCodexAppServerNetworkProxy } from "./config-security.js";

type SessionPermissionMode = NonNullable<EmbeddedRunAttemptParamsV2["permissionMode"]>;

export type CodexEffectiveSessionPermissionPolicy = {
  mode: SessionPermissionMode;
  root: string;
  execMode: OpenClawExecMode;
};

export const CODEX_SESSION_PERMISSION_EXEC_MODES = {
  "read-only": "deny",
  guarded: "ask",
  workspace: "auto",
  full: "full",
} satisfies Record<SessionPermissionMode, OpenClawExecMode>;

type CodexSessionPermissionTuple = {
  approvalPolicy: CodexAppServerApprovalPolicy;
  approvalsReviewer: CodexAppServerApprovalsReviewer;
  sandbox: CodexAppServerSandboxMode;
};

function tupleForMode(
  mode: SessionPermissionMode,
  canUseAutoReview: boolean,
): CodexSessionPermissionTuple {
  switch (mode) {
    case "read-only":
      return { sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user" };
    case "guarded":
      return {
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      };
    case "workspace":
      return {
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: canUseAutoReview ? "auto_review" : "user",
      };
    case "full":
      return {
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        approvalsReviewer: "user",
      };
  }
  return mode satisfies never;
}

function requirementsAllowTuple(
  tuple: CodexSessionPermissionTuple,
  allowed: {
    sandboxes: Set<CodexAppServerSandboxMode> | undefined;
    approvalPolicies: Set<CodexAppServerApprovalPolicy> | undefined;
    reviewers: Set<CodexAppServerApprovalsReviewer> | undefined;
  },
): boolean {
  return (
    (allowed.sandboxes === undefined || allowed.sandboxes.has(tuple.sandbox)) &&
    (allowed.approvalPolicies === undefined ||
      allowed.approvalPolicies.has(tuple.approvalPolicy)) &&
    (allowed.reviewers === undefined || allowed.reviewers.has(tuple.approvalsReviewer))
  );
}

function tightenTupleForExecMode(
  tuple: CodexSessionPermissionTuple,
  execMode: OpenClawExecMode | undefined,
): CodexSessionPermissionTuple {
  switch (execMode) {
    case "deny":
    case "allowlist":
      return { sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user" };
    case "ask":
      return { ...tuple, approvalPolicy: "on-request", approvalsReviewer: "user" };
    case "auto":
    case "full":
    case undefined:
      return tuple;
  }
  return execMode satisfies never;
}

function clampSessionPermissionTuple(params: {
  mode: SessionPermissionMode;
  requested: CodexSessionPermissionTuple;
  requirementsToml?: string;
  hostName?: string;
  canUseAutoReview: boolean;
}): CodexSessionPermissionTuple {
  if (!params.requirementsToml) {
    return params.requested;
  }
  const allowed = {
    sandboxes: parseAllowedSandboxModesFromCodexRequirements(
      params.requirementsToml,
      params.hostName ?? readHostName(),
    ),
    approvalPolicies: parseAllowedApprovalPoliciesFromCodexRequirements(params.requirementsToml),
    reviewers: parseAllowedApprovalsReviewersFromCodexRequirements(params.requirementsToml),
  };
  if (requirementsAllowTuple(params.requested, allowed)) {
    return params.requested;
  }

  const userReviewRequired =
    params.mode === "read-only" ||
    params.mode === "guarded" ||
    (params.mode === "workspace" && !params.canUseAutoReview);
  return {
    sandbox: selectGuardianSandbox(allowed.sandboxes),
    approvalPolicy: selectGuardianApprovalPolicy(
      allowed.approvalPolicies,
      userReviewRequired ? "ask" : "auto",
    ),
    approvalsReviewer: userReviewRequired
      ? selectUserApprovalsReviewer(allowed.reviewers)
      : selectGuardianApprovalsReviewer(allowed.reviewers, "auto"),
  };
}

/** Applies one complete session-mode tuple without mixing requirements-clamped fields. */
export function applyCodexSessionPermissionPolicy(params: {
  appServer: CodexAppServerRuntimeOptions;
  permissionMode?: SessionPermissionMode;
  sessionRoot?: string;
  pluginConfig: CodexPluginConfig;
  canUseAutoReview: boolean;
  requirementsToml?: string;
  hostName?: string;
  policyLocked?: boolean;
  execMode?: OpenClawExecMode;
}): CodexAppServerRuntimeOptions {
  if (!params.permissionMode) {
    return params.appServer;
  }
  const sessionRoot = params.sessionRoot?.trim();
  if (!sessionRoot) {
    throw new Error("Codex session permission mode requires a recorded session root");
  }
  if (params.policyLocked) {
    return { ...params.appServer, sessionRoot };
  }

  const requested = tightenTupleForExecMode(
    tupleForMode(params.permissionMode, params.canUseAutoReview),
    params.execMode,
  );
  const tuple =
    params.appServer.start.transport === "stdio"
      ? clampSessionPermissionTuple({
          mode: params.permissionMode,
          requested,
          requirementsToml: params.requirementsToml,
          hostName: params.hostName,
          canUseAutoReview: params.canUseAutoReview,
        })
      : requested;
  const networkProxy = params.appServer.networkProxy
    ? resolveCodexAppServerNetworkProxy(params.pluginConfig.appServer?.networkProxy, tuple.sandbox)
        .networkProxy
    : undefined;
  const resolved = {
    ...params.appServer,
    ...tuple,
    sessionRoot,
  };
  if (networkProxy) {
    resolved.networkProxy = networkProxy;
  } else {
    delete resolved.networkProxy;
  }
  return resolved;
}

export function resolveCodexEffectiveSessionPermissionPolicy(params: {
  appServer: CodexAppServerRuntimeOptions;
  permissionMode?: SessionPermissionMode;
  sessionRoot?: string;
}): CodexEffectiveSessionPermissionPolicy | undefined {
  if (!params.permissionMode) {
    return undefined;
  }
  const root = params.sessionRoot?.trim();
  if (!root) {
    throw new Error("Codex session permission mode requires a recorded session root");
  }
  const { sandbox, approvalPolicy, approvalsReviewer } = params.appServer;
  const fullAccess =
    params.permissionMode === "full" &&
    sandbox === "danger-full-access" &&
    approvalPolicy === "never";
  const guardianReview =
    params.permissionMode !== "guarded" &&
    sandbox === "workspace-write" &&
    approvalPolicy === "on-request" &&
    approvalsReviewer !== "user";
  const mode =
    params.permissionMode === "read-only" || sandbox === "read-only"
      ? "read-only"
      : fullAccess
        ? "full"
        : guardianReview
          ? "workspace"
          : "guarded";
  return { mode, root, execMode: CODEX_SESSION_PERMISSION_EXEC_MODES[mode] };
}

/** Keeps relative execution inside the prepared root without filesystem rediscovery. */
export function resolveCodexSessionPermissionCwd(params: {
  permissionMode?: SessionPermissionMode;
  sessionRoot?: string;
  requestedCwd?: string;
  fallbackCwd: string;
}): string {
  if (!params.permissionMode) {
    return params.requestedCwd ?? params.fallbackCwd;
  }
  const sessionRoot = params.sessionRoot?.trim();
  if (!sessionRoot) {
    throw new Error("Codex session permission mode requires a recorded session root");
  }
  const requestedCwd = params.requestedCwd?.trim();
  return requestedCwd && isPathInside(sessionRoot, requestedCwd) ? requestedCwd : sessionRoot;
}
