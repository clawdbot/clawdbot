// Gateway startup warning for requested exec policy clamped by host approvals.
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  collectExecPolicyScopeSnapshots,
  isExecPolicySecurityClampedByHost,
  type ExecPolicyScopeSnapshot,
} from "../../infra/exec-approvals-effective.js";
import { readExecApprovalsSnapshot, type ExecApprovalsFile } from "../../infra/exec-approvals.js";
import { resolveExecTarget } from "../../infra/exec-target-resolution.js";
import { normalizeAgentId } from "../../routing/session-key.js";

const EXEC_APPROVALS_DOCS_URL = "https://docs.openclaw.ai/tools/exec-approvals";

function sandboxModeOwnsStartupAutoExec(mode: string | undefined): boolean {
  return mode === "all";
}

function resolveStartupSandboxAvailable(cfg: OpenClawConfig): boolean {
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const defaultAgent = agents.find((agent) => normalizeAgentId(agent?.id) === defaultAgentId);
  return sandboxModeOwnsStartupAutoExec(
    defaultAgent?.sandbox?.mode ?? cfg.agents?.defaults?.sandbox?.mode,
  );
}

function hostSecuritySourceIsDefaults(source: string): boolean {
  return /\bdefaults\.security$/.test(source);
}

function buildSecurityClampRemediation(globalScope: ExecPolicyScopeSnapshot): string {
  if (
    hostSecuritySourceIsDefaults(globalScope.security.hostSource) &&
    globalScope.security.requestedSource !== "tools.exec.mode"
  ) {
    return `Run "openclaw exec-policy set --security ${globalScope.security.requested}" to synchronize host approvals, or "openclaw exec-policy show" for details.`;
  }
  return `Run "openclaw exec-policy show" to inspect the clamping scope. See ${EXEC_APPROVALS_DOCS_URL} before changing host approvals.`;
}

function buildGlobalExecPolicyClampWarning(params: {
  cfg: OpenClawConfig;
  approvals: ExecApprovalsFile;
  approvalsPath?: string;
  sandboxAvailable?: boolean;
}): string | undefined {
  const globalScope = collectExecPolicyScopeSnapshots({
    cfg: params.cfg,
    approvals: params.approvals,
    hostPath: params.approvalsPath,
  })[0];
  const effectiveHost = globalScope
    ? resolveExecTarget({
        configuredTarget: globalScope.host.requested,
        elevatedRequested: false,
        sandboxAvailable: params.sandboxAvailable ?? resolveStartupSandboxAvailable(params.cfg),
      }).effectiveHost
    : undefined;
  if (
    !globalScope ||
    effectiveHost !== "gateway" ||
    !isExecPolicySecurityClampedByHost(globalScope)
  ) {
    return undefined;
  }
  const requestedSecurityDescription =
    globalScope.security.requestedSource === "tools.exec.mode"
      ? `${globalScope.security.requestedSource} requests security=${globalScope.security.requested}`
      : `${globalScope.security.requestedSource}=${globalScope.security.requested}`;
  const remediation = buildSecurityClampRemediation(globalScope);
  return sanitizeTerminalText(
    [
      `${requestedSecurityDescription} is clamped to ${globalScope.security.effective} by host approvals (${globalScope.security.hostSource}).`,
      remediation,
    ].join(" "),
  );
}

export function buildCurrentGlobalExecPolicyClampWarning(cfg: OpenClawConfig): string | undefined {
  try {
    const approvals = readExecApprovalsSnapshot();
    return buildGlobalExecPolicyClampWarning({
      cfg,
      approvals: approvals.file,
      approvalsPath: approvals.path,
    });
  } catch {
    return undefined;
  }
}
