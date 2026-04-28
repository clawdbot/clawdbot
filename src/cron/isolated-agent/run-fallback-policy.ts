import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import { resolveEffectiveModelFallbacks } from "./run-execution.runtime.js";

export function resolveCronFallbacksOverride(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
}): string[] | undefined {
  const payload = params.job.payload.kind === "agentTurn" ? params.job.payload : undefined;
  const payloadFallbacks = Array.isArray(payload?.fallbacks) ? payload.fallbacks : undefined;
  const hasCronPayloadModelOverride =
    typeof payload?.model === "string" && payload.model.trim().length > 0;
  return (
    payloadFallbacks ??
    resolveEffectiveModelFallbacks({
      cfg: params.cfg,
      agentId: params.agentId,
      hasSessionModelOverride: hasCronPayloadModelOverride,
      modelOverrideSource: hasCronPayloadModelOverride ? "auto" : undefined,
    })
  );
}
