import { resolveAgentWorkspaceDir, tryResolveSoleAgentId } from "../agents/agent-scope.js";
import { isLegacyParentWritableUpdateDoctorPass } from "../commands/doctor/shared/update-phase.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

export function isUpdateDoctorRun(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  const value = env.OPENCLAW_UPDATE_IN_PROGRESS;
  return value === "1" || value === "true";
}

export function resolveDoctorMode(cfg: OpenClawConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}
export function resolveDoctorWorkspaceDir(cfg: OpenClawConfig, env = process.env) {
  const agentId = tryResolveSoleAgentId(cfg);
  return agentId ? resolveAgentWorkspaceDir(cfg, agentId, env) : undefined;
}

export function resolveLegacyParentVersionOverride(ctx: DoctorHealthFlowContext): {
  lastTouchedVersionOverride?: string;
} {
  if (!isLegacyParentWritableUpdateDoctorPass(ctx.env ?? process.env)) {
    return {};
  }
  const version = ctx.configResult.sourceLastTouchedVersion?.trim();
  return version ? { lastTouchedVersionOverride: version } : {};
}
