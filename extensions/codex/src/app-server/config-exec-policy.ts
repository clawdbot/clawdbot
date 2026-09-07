import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-registration";
import type {
  CodexAppServerApprovalPolicy,
  CodexAppServerApprovalsReviewer,
  CodexAppServerDefaultPolicy,
  CodexAppServerPolicyMode,
  CodexAppServerSandboxMode,
  OpenClawExecMode,
  OpenClawExecPolicyForCodexAppServer,
} from "./config-contracts.js";

export function selectForcedPromptingSandbox(params: {
  configuredSandbox?: CodexAppServerSandboxMode;
  defaultSandbox?: CodexAppServerSandboxMode;
}): CodexAppServerSandboxMode {
  if (params.configuredSandbox === "read-only" || params.defaultSandbox === "read-only") {
    return "read-only";
  }
  return params.defaultSandbox ?? "workspace-write";
}

export function selectForcedDangerFullAccessSandbox(params: {
  configuredSandbox?: CodexAppServerSandboxMode;
  defaultPolicy: CodexAppServerDefaultPolicy | undefined;
  openClawSandboxActive: boolean;
}): CodexAppServerSandboxMode {
  if (params.configuredSandbox === "read-only") {
    return "read-only";
  }
  if (params.defaultPolicy?.dangerFullAccessAllowed === false) {
    if (params.openClawSandboxActive) {
      return params.defaultPolicy.sandbox ?? "workspace-write";
    }
    throw new Error(
      "legacy full exec security with ask requires Codex app-server danger-full-access",
    );
  }
  return "danger-full-access";
}

export function selectGuardianSandbox(
  allowedSandboxModes: Set<CodexAppServerSandboxMode> | undefined,
): CodexAppServerSandboxMode {
  if (allowedSandboxModes === undefined || allowedSandboxModes.has("workspace-write")) {
    return "workspace-write";
  }
  if (allowedSandboxModes.has("read-only")) {
    return "read-only";
  }
  if (allowedSandboxModes.has("danger-full-access")) {
    return "danger-full-access";
  }
  return "workspace-write";
}

export function resolveApprovalPolicy(value: unknown): CodexAppServerApprovalPolicy | undefined {
  if (value === "untrusted") {
    throw new Error(
      'Codex app-server approval policy "untrusted" is retired; run "openclaw doctor --fix" and use "on-request".',
    );
  }
  if (value === "on-failure") {
    return "on-request";
  }
  return value === "on-request" || value === "never" ? value : undefined;
}

export function resolveSandbox(value: unknown): CodexAppServerSandboxMode | undefined {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : undefined;
}

export function resolveApprovalsReviewer(
  value: unknown,
): CodexAppServerApprovalsReviewer | undefined {
  return value === "auto_review" || value === "guardian_subagent" || value === "user"
    ? value
    : undefined;
}

export function resolveEffectiveOpenClawExecModeForCodexAppServer(params: {
  execMode?: OpenClawExecMode;
  execPolicy?: OpenClawExecPolicyForCodexAppServer;
}): OpenClawExecMode | undefined {
  if (params.execPolicy?.touched === true) {
    return params.execPolicy.mode;
  }
  return params.execMode;
}

export function resolveCodexPolicyModeForOpenClawExecMode(
  mode: OpenClawExecMode | undefined,
): CodexAppServerPolicyMode | undefined {
  if (!mode || mode === "full") {
    return undefined;
  }
  return "guardian";
}

export function assertCodexAppServerAllowedForOpenClawExecMode(
  mode: OpenClawExecMode | undefined,
): void {
  if (mode === "deny" || mode === "allowlist") {
    throw new AgentHarnessPreflightError(
      `Codex app-server local execution is unavailable because effective tools.exec.mode=${mode}. ` +
        "Execution-host approvals are authoritative. For gateway turns, inspect them with `openclaw approvals get --gateway` and update that same target with `openclaw approvals set --gateway --stdin`; for local `agent exec`, omit `--gateway`. Intentionally align that host policy before retrying.",
      { scope: "harness" },
    );
  }
}
