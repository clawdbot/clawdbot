import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertCurrentDenylistAuthorization,
  type ExecDenylistAuthorizationBinding,
} from "../infra/exec-approvals-denylist-authorization.js";
import {
  buildExecDenylistRuleKey,
  evaluateExecDenylist,
  type ExecDenylistEntry,
} from "../infra/exec-approvals-denylist.js";
import { resolveEffectiveExecDenylist } from "../infra/exec-approvals-denylist.js";
import type { ExecCommandSegment } from "../infra/exec-approvals.js";
import type { ExecHostDenylistAuthorizationSnapshot } from "../infra/exec-host.js";
import { normalizeAgentId } from "../routing/session-key.js";

type SystemRunDenylistPhase = {
  commandText: string;
  segments: readonly ExecCommandSegment[];
  analysisOk: boolean;
  agentId?: string;
  denylistConfigEntries: readonly ExecDenylistEntry[];
  approvedDenylistRuleKeys: readonly string[];
  denylisted: boolean;
};

export function evaluateSystemRunDenylistPolicy(params: {
  config: OpenClawConfig;
  agentExecDenylist?: readonly ExecDenylistEntry[];
  commandText: string;
  segments: readonly ExecCommandSegment[];
  analysisOk: boolean;
}) {
  const denylistConfigEntries = resolveEffectiveExecDenylist({
    layers: [params.config.tools?.exec?.denylist, params.agentExecDenylist],
  });
  const evaluation = evaluateExecDenylist({
    command: params.commandText,
    segments: params.segments,
    denylist: denylistConfigEntries,
    analysisOk: params.analysisOk,
  });
  const denylisted = evaluation.match !== null || evaluation.conservativeApproval;
  return {
    denylistConfigEntries,
    approvedDenylistRuleKeys: denylistConfigEntries.map(buildExecDenylistRuleKey),
    denylisted,
    denylistReason: evaluation.match
      ? `${evaluation.match.pattern}${evaluation.match.reason ? `: ${evaluation.match.reason}` : ""}`
      : evaluation.conservativeApproval
        ? "command could not be screened against the configured exec denylist"
        : null,
  };
}

export async function resolveRuntimeConfigAccessor(opts: {
  getRuntimeConfig?: () => OpenClawConfig;
}): Promise<() => OpenClawConfig> {
  if (opts.getRuntimeConfig) {
    return opts.getRuntimeConfig;
  }
  const { getRuntimeConfig } = await import("../config/config.js");
  return getRuntimeConfig;
}

function resolveAgentExecDenylist(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): readonly ExecDenylistEntry[] | undefined {
  if (!agentId) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(agentId);
  const entry = cfg.agents?.list?.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      normalizeAgentId(candidate.id) === normalizedAgentId,
  );
  return entry?.tools?.exec?.denylist;
}

function resolveCurrentSystemRunConfigDenylist(
  getConfig: () => OpenClawConfig,
  agentId: string | undefined,
): readonly ExecDenylistEntry[] {
  const cfg = getConfig();
  return resolveEffectiveExecDenylist({
    layers: [cfg.tools?.exec?.denylist, resolveAgentExecDenylist(cfg, agentId)],
  });
}

export function buildSystemRunDenylistBinding(
  phase: SystemRunDenylistPhase,
  getConfig: () => OpenClawConfig,
  execArgv?: readonly string[],
): ExecDenylistAuthorizationBinding {
  const segments =
    phase.analysisOk && execArgv && execArgv.length > 0
      ? [...phase.segments, { argv: [...execArgv] }]
      : phase.segments;
  return {
    command: phase.commandText,
    segments,
    analysisOk: phase.analysisOk,
    configDenylist: phase.denylistConfigEntries,
    resolveCurrentConfigDenylist: () =>
      resolveCurrentSystemRunConfigDenylist(getConfig, phase.agentId),
    approvedRuleKeys: phase.approvedDenylistRuleKeys,
  };
}

export function toPortableDenylistBinding(
  phase: SystemRunDenylistPhase,
): ExecHostDenylistAuthorizationSnapshot {
  return {
    command: phase.commandText,
    analysisOk: phase.analysisOk,
    configDenylist: [...phase.denylistConfigEntries],
    approvedRuleKeys: [...phase.approvedDenylistRuleKeys],
    denylisted: phase.denylisted,
  };
}

export function assertSystemRunDenylistAuthorization(params: {
  agentId: string | undefined;
  binding: ExecDenylistAuthorizationBinding | undefined;
}): void {
  assertCurrentDenylistAuthorization({
    binding: params.binding,
  });
}
