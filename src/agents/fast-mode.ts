import { normalizeFastMode } from "../auto-reply/thinking.shared.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { modelKey } from "./model-ref-shared.js";

type FastModeState = {
  enabled: boolean;
  source: "session" | "agent" | "config" | "default";
};

function resolveConfiguredFastModeRaw(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
}): unknown {
  const modelConfig =
    params.cfg?.agents?.defaults?.models?.[modelKey(params.provider, params.model)];
  return modelConfig?.params?.fastMode ?? modelConfig?.params?.fast_mode;
}

export function resolveFastModeState(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentId?: string;
  sessionEntry?: Pick<SessionEntry, "fastMode"> | undefined;
}): FastModeState {
  const sessionOverride = normalizeFastMode(params.sessionEntry?.fastMode);
  if (sessionOverride !== undefined) {
    return { enabled: sessionOverride, source: "session" };
  }

  const agentDefault =
    params.agentId && params.cfg
      ? resolveAgentConfig(params.cfg, params.agentId)?.fastModeDefault
      : undefined;
  if (typeof agentDefault === "boolean") {
    return { enabled: agentDefault, source: "agent" };
  }

  const configuredRaw = resolveConfiguredFastModeRaw(params);
  const configured = normalizeFastMode(configuredRaw as string | boolean | null | undefined);
  if (configured !== undefined) {
    return { enabled: configured, source: "config" };
  }

  return { enabled: false, source: "default" };
}
