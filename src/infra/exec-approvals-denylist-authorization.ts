import {
  buildExecDenylistRuleKey,
  type ExecDenylistEntry,
  type ExecDenylistSegment,
  evaluateExecDenylist,
  resolveEffectiveExecDenylist,
} from "./exec-approvals-denylist.js";

export type ExecDenylistAuthorizationBinding = {
  command: string;
  segments: readonly ExecDenylistSegment[];
  analysisOk: boolean;
  configDenylist: readonly ExecDenylistEntry[];
  resolveCurrentConfigDenylist?: () => readonly ExecDenylistEntry[];
  approvedRuleKeys: readonly string[];
};

export function assertCurrentDenylistAuthorization(params: {
  binding: ExecDenylistAuthorizationBinding | undefined;
}): void {
  const binding = params.binding;
  if (!binding) {
    return;
  }
  const currentConfigDenylist = binding.resolveCurrentConfigDenylist?.() ?? binding.configDenylist;
  const currentEffective = resolveEffectiveExecDenylist({
    layers: [currentConfigDenylist],
  });
  const approvedRuleKeys = new Set(binding.approvedRuleKeys);
  const newlyCurrent = currentEffective.filter(
    (entry) => !approvedRuleKeys.has(buildExecDenylistRuleKey(entry)),
  );
  if (newlyCurrent.length === 0) {
    return;
  }
  const evaluation = evaluateExecDenylist({
    command: binding.command,
    segments: binding.segments,
    denylist: newlyCurrent,
    analysisOk: binding.analysisOk,
  });
  if (evaluation.match !== null || evaluation.conservativeApproval) {
    throw new Error("Exec approval changed before execution");
  }
}
