// Policy doctor shared types.
import type { HealthCheckContext, HealthFinding } from "openclaw/plugin-sdk/health";
import type { PolicyEvidence } from "../policy-state.js";
import type { POLICY_CHECK_IDS } from "./check-ids.js";

export type PolicyEvaluation = {
  readonly policyPath: string;
  readonly policy?: {
    readonly value: unknown;
    readonly hash: string;
  };
  readonly evidence: PolicyEvidence;
  readonly expectedAttestationHash?: string;
  readonly findings: readonly HealthFinding[];
  readonly attestedFindings: readonly HealthFinding[];
};

export type PolicyDoctorCheckDeps = {
  readonly evaluatePolicy: (ctx: HealthCheckContext) => Promise<PolicyEvaluation>;
  readonly findingsForCheck: (
    evaluation: PolicyEvaluation,
    checkId: (typeof POLICY_CHECK_IDS)[number],
  ) => readonly HealthFinding[];
  readonly workspaceRepairsEnabled: (ctx: HealthCheckContext) => boolean;
  readonly workspaceRepairsDisabledResult: (fileName: string) => {
    readonly status: "skipped";
    readonly reason: string;
    readonly changes: readonly string[];
  };
  readonly channelIdsFromFindings: (findings: readonly HealthFinding[]) => readonly string[];
  readonly disableChannels: (
    cfg: HealthCheckContext["cfg"],
    channelIds: readonly string[],
  ) => { readonly config: HealthCheckContext["cfg"]; readonly changed: readonly string[] };
};
