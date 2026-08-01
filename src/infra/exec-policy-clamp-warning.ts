// Gateway start warning for the requested exec policy clamped by host approvals.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { listAgentEntries, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  collectExecPolicyScopeSnapshots,
  isExecPolicySecurityClampedByHost,
  type ExecPolicyScopeSnapshot,
} from "./exec-approvals-effective.js";
import { readExecApprovalsSnapshot, type ExecApprovalsFile } from "./exec-approvals.js";
import { resolveExecTarget } from "./exec-target-resolution.js";

const EXEC_APPROVALS_DOCS_URL = "https://docs.openclaw.ai/tools/exec-approvals";
const GLOBAL_EXEC_SCOPE_CONFIG_PATH = "tools.exec";

function sandboxModeOwnsAutoExec(mode: string | undefined): boolean {
  return mode === "all";
}

// Read the roster through the canonical resolver, not `agents.list`: `agents.entries` is
// the serialized shape and `list` is only an internal projection, so reading `list`
// directly drops per-agent sandbox overrides and silences a real clamp.
function defaultAgentSandboxOwnsExec(cfg: OpenClawConfig, defaultAgentId: string): boolean {
  const defaultAgent = listAgentEntries(cfg).find(
    (agent) => normalizeAgentId(agent.id) === defaultAgentId,
  );
  return sandboxModeOwnsAutoExec(
    defaultAgent?.sandbox?.mode ?? cfg.agents?.defaults?.sandbox?.mode,
  );
}

// `collectExecPolicyScopeSnapshots` emits the global `tools.exec` scope first and adds a
// default-agent scope only when that agent overrides `tools.exec`. Runtime layers that
// override over the global config, so judging the global snapshot unconditionally would
// report a policy the default agent never runs under — in either direction.
function resolveDefaultAgentExecScope(params: {
  cfg: OpenClawConfig;
  approvals: ExecApprovalsFile;
  approvalsPath?: string;
  defaultAgentId: string;
}): ExecPolicyScopeSnapshot | undefined {
  const snapshots = collectExecPolicyScopeSnapshots({
    cfg: params.cfg,
    approvals: params.approvals,
    hostPath: params.approvalsPath,
  });
  const defaultAgentScope = snapshots.find(
    (snapshot) =>
      snapshot.agentId === params.defaultAgentId &&
      snapshot.configPath !== GLOBAL_EXEC_SCOPE_CONFIG_PATH,
  );
  return defaultAgentScope ?? snapshots[0];
}

function hostSecuritySourceIsDefaults(source: string): boolean {
  return /\bdefaults\.security$/.test(source);
}

// Mode-derived sources end in `.mode` at every scope (`tools.exec.mode`,
// `agents.entries.<id>.tools.exec.mode`). Those configs cannot take a `--security` edit
// without clobbering the mode, so they only get diagnostic guidance.
function requestedSecurityIsModeDerived(source: string): boolean {
  return source.endsWith(".mode");
}

function buildSecurityClampRemediation(scope: ExecPolicyScopeSnapshot): string {
  if (
    hostSecuritySourceIsDefaults(scope.security.hostSource) &&
    !requestedSecurityIsModeDerived(scope.security.requestedSource)
  ) {
    return `Run "openclaw exec-policy set --security ${scope.security.requested}" to synchronize host approvals, or "openclaw exec-policy show" for details.`;
  }
  return `Run "openclaw exec-policy show" to inspect the clamping scope. See ${EXEC_APPROVALS_DOCS_URL} before changing host approvals.`;
}

export function buildCurrentExecPolicyClampWarning(cfg: OpenClawConfig): string | undefined {
  try {
    const approvals = readExecApprovalsSnapshot();
    const defaultAgentId = resolveDefaultAgentId(cfg);
    const scope = resolveDefaultAgentExecScope({
      cfg,
      approvals: approvals.file,
      approvalsPath: approvals.path,
      defaultAgentId,
    });
    if (!scope || !isExecPolicySecurityClampedByHost(scope)) {
      return undefined;
    }
    const { effectiveHost } = resolveExecTarget({
      configuredTarget: scope.host.requested,
      elevatedRequested: false,
      sandboxAvailable: defaultAgentSandboxOwnsExec(cfg, defaultAgentId),
    });
    if (effectiveHost !== "gateway") {
      return undefined;
    }
    const requestedSecurityDescription = requestedSecurityIsModeDerived(
      scope.security.requestedSource,
    )
      ? `${scope.security.requestedSource} requests security=${scope.security.requested}`
      : `${scope.security.requestedSource}=${scope.security.requested}`;
    return sanitizeTerminalText(
      [
        `${requestedSecurityDescription} is clamped to ${scope.security.effective} by host approvals (${scope.security.hostSource}).`,
        buildSecurityClampRemediation(scope),
      ].join(" "),
    );
  } catch {
    return undefined;
  }
}
