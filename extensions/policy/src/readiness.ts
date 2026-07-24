import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  type HealthCheckContext,
} from "openclaw/plugin-sdk/health";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { policyChecksEnabled, policySettings } from "./doctor/policy-runtime.js";
import { evaluatePolicy } from "./doctor/register.js";

type PolicyReadinessCriterion = Parameters<OpenClawPluginApi["registerReadinessCriterion"]>[0];

export function createPolicyReadinessCriterion(): PolicyReadinessCriterion {
  return {
    id: "conformant",
    description: "Reports whether the enabled Policy plugin has no findings.",
    async check({ config, signal }) {
      signal.throwIfAborted();
      const ctx: HealthCheckContext = {
        mode: "lint",
        cfg: config,
        cwd: resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)),
        runtime: {
          log() {},
          error() {},
          exit() {},
        },
      };
      if (!policyChecksEnabled(ctx, policySettings(ctx))) {
        return {
          status: "Unknown",
          reason: "PolicyChecksDisabled",
          message: "Policy checks are not enabled for this runtime.",
        };
      }
      const evaluation = await evaluatePolicy(ctx);
      signal.throwIfAborted();
      const findingCount = evaluation.findings.length;
      return findingCount === 0
        ? {
            status: "True",
            reason: "PolicyConformant",
            message: "Policy evaluation completed without findings.",
          }
        : {
            status: "False",
            reason: "PolicyFindingsPresent",
            message: `Policy evaluation reported ${findingCount} finding(s).`,
          };
    },
  };
}
