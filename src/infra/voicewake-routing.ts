// Persists and resolves voice wake routing rules.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId } from "../routing/session-key.js";
import { readConfigMachineState } from "../state/config-machine-state.js";

// Voice wake routing maps normalized wake phrases to an agent, session key, or
// current session target and persists the mapping under state settings.
type VoiceWakeRouteTarget =
  | { mode: "current"; agentId?: undefined; sessionKey?: undefined }
  | { agentId: string; sessionKey?: undefined; mode?: undefined }
  | { sessionKey: string; agentId?: undefined; mode?: undefined };

type VoiceWakeRouteRule = {
  trigger: string;
  target: VoiceWakeRouteTarget;
};

export type VoiceWakeRoutingConfig = {
  version: 1;
  defaultTarget: VoiceWakeRouteTarget;
  routes: VoiceWakeRouteRule[];
  updatedAtMs: number;
};

const VOICEWAKE_ROUTING_STATE_KEY = "voicewake.routing";

const DEFAULT_ROUTING: VoiceWakeRoutingConfig = {
  version: 1,
  defaultTarget: { mode: "current" },
  routes: [],
  updatedAtMs: 0,
};

/** Normalize a voice wake trigger phrase for matching and duplicate checks. */
function normalizeVoiceWakeTriggerWord(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ""))
    .filter(Boolean)
    .join(" ");
}

function normalizeRouteTarget(value: unknown): VoiceWakeRouteTarget | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const rec = value as { mode?: unknown; agentId?: unknown; sessionKey?: unknown };
  const mode = normalizeOptionalString(rec.mode);
  if (mode === "current") {
    return { mode: "current" };
  }
  const agentId = normalizeOptionalString(rec.agentId);
  const sessionKey = normalizeOptionalString(rec.sessionKey);
  if (agentId && !sessionKey) {
    return { agentId: normalizeAgentId(agentId) };
  }
  if (sessionKey && !agentId) {
    return { sessionKey };
  }
  return null;
}

function normalizeRouteRule(value: unknown): VoiceWakeRouteRule | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const rec = value as { trigger?: unknown; target?: unknown };
  const triggerRaw = normalizeOptionalString(rec.trigger);
  if (!triggerRaw) {
    return null;
  }
  const trigger = normalizeVoiceWakeTriggerWord(triggerRaw);
  if (!trigger) {
    return null;
  }
  const target = normalizeRouteTarget(rec.target);
  if (!target) {
    return null;
  }
  return { trigger, target };
}

/** Normalize persisted or user-provided voice wake routing config. */
export function normalizeVoiceWakeRoutingConfig(input: unknown): VoiceWakeRoutingConfig {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_ROUTING };
  }
  const rec = input as {
    version?: unknown;
    defaultTarget?: unknown;
    routes?: unknown;
    updatedAtMs?: unknown;
  };
  const defaultTarget = normalizeRouteTarget(rec.defaultTarget) ?? { mode: "current" as const };
  const routes = Array.isArray(rec.routes)
    ? rec.routes
        .map((entry) => normalizeRouteRule(entry))
        .filter((entry): entry is VoiceWakeRouteRule => Boolean(entry))
    : [];
  const updatedAtMs =
    typeof rec.updatedAtMs === "number" && Number.isFinite(rec.updatedAtMs) && rec.updatedAtMs > 0
      ? Math.floor(rec.updatedAtMs)
      : 0;
  return {
    version: 1,
    defaultTarget,
    routes,
    updatedAtMs,
  };
}

/** Load persisted voice wake routing config from state. */
export async function loadVoiceWakeRoutingConfig(
  baseDir?: string,
): Promise<VoiceWakeRoutingConfig> {
  const config = readConfigMachineState<VoiceWakeRoutingConfig>(
    VOICEWAKE_ROUTING_STATE_KEY,
    baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {},
  );
  return config ? normalizeVoiceWakeRoutingConfig(config) : { ...DEFAULT_ROUTING };
}

type VoiceWakeResolvedRoute = { mode: "current" } | { agentId: string } | { sessionKey: string };

function resolveVoiceWakeRouteTarget(
  routeTarget: VoiceWakeRouteTarget | undefined,
): VoiceWakeResolvedRoute {
  if (!routeTarget || ("mode" in routeTarget && routeTarget.mode === "current")) {
    return { mode: "current" };
  }
  if ("agentId" in routeTarget && routeTarget.agentId) {
    return { agentId: routeTarget.agentId };
  }
  if ("sessionKey" in routeTarget && routeTarget.sessionKey) {
    return { sessionKey: routeTarget.sessionKey };
  }
  return { mode: "current" };
}

/** Resolve the route target for a normalized wake trigger. */
export function resolveVoiceWakeRouteByTrigger(params: {
  trigger: string | undefined;
  config: VoiceWakeRoutingConfig;
}): VoiceWakeResolvedRoute {
  const normalizedTrigger = normalizeOptionalString(params.trigger)
    ? normalizeVoiceWakeTriggerWord(params.trigger as string)
    : "";
  if (normalizedTrigger) {
    const matched = params.config.routes.find((route) => route.trigger === normalizedTrigger);
    if (matched) {
      return resolveVoiceWakeRouteTarget(matched.target);
    }
  }
  return resolveVoiceWakeRouteTarget(params.config.defaultTarget);
}
