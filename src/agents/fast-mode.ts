/**
 * Resolves fast-mode state from agent config and runtime defaults.
 */
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import { normalizeFastMode } from "../auto-reply/thinking.shared.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type FastModeSource, resolveFastModeModelAutoOnSeconds } from "../shared/fast-mode.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { resolveModelExtraParamSources } from "./model-extra-params.js";

export {
  DEFAULT_FAST_MODE_AUTO_ON_SECONDS,
  formatFastModeAutoProgressText,
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  formatFastModeSourceSuffix,
  formatFastModeStatusValue,
  formatFastModeValue,
  resolveFastModeForElapsed,
} from "../shared/fast-mode.js";
export type { FastModeAutoProgressState } from "../shared/fast-mode.js";

// Resolves effective fast-mode state from session, agent, model config, then
// default. Callers keep the source for diagnostics and prompt explanations.
type FastModeState = {
  mode: FastMode;
  enabled: boolean;
  source: FastModeSource;
  fastAutoOnSeconds: number;
};

/** Resolve the effective fast-mode setting and its source. */
export function resolveFastModeState(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentId?: string;
  sessionEntry?: Pick<SessionEntry, "fastMode"> | undefined;
}): FastModeState {
  const { modelParams, agentModelParams } = resolveModelExtraParamSources({
    config: params.cfg,
    provider: params.provider,
    modelId: params.model,
    agentId: params.agentId,
  });
  const fastAutoOnSeconds = resolveFastModeModelAutoOnSeconds({
    ...params,
    modelParamSources: [agentModelParams, modelParams],
  });
  const sessionOverride = normalizeFastMode(params.sessionEntry?.fastMode);
  if (sessionOverride !== undefined) {
    return {
      mode: sessionOverride,
      enabled: sessionOverride === "auto" ? true : sessionOverride,
      source: "session",
      fastAutoOnSeconds,
    };
  }

  const agentDefault =
    params.agentId && params.cfg
      ? resolveAgentConfig(params.cfg, params.agentId)?.fastModeDefault
      : undefined;
  const normalizedAgentDefault = normalizeFastMode(agentDefault);
  if (normalizedAgentDefault !== undefined) {
    return {
      mode: normalizedAgentDefault,
      enabled: normalizedAgentDefault === "auto" ? true : normalizedAgentDefault,
      source: "agent",
      fastAutoOnSeconds,
    };
  }

  const configuredRaw =
    agentModelParams?.fastMode ??
    agentModelParams?.fast_mode ??
    modelParams?.fastMode ??
    modelParams?.fast_mode;
  const configured = normalizeFastMode(configuredRaw as string | boolean | null | undefined);
  if (configured !== undefined) {
    return {
      mode: configured,
      enabled: configured === "auto" ? true : configured,
      source: "config",
      fastAutoOnSeconds,
    };
  }

  return {
    mode: false,
    enabled: false,
    source: "default",
    fastAutoOnSeconds,
  };
}
