// Persists and resolves voice wake routing rules.
import { isRecord as isPlainObject } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  classifySessionKeyShape,
  isValidAgentId,
  normalizeAgentId,
} from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

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

const MAX_VOICEWAKE_ROUTES = 32;
const MAX_VOICEWAKE_TRIGGER_LENGTH = 64;
const VOICEWAKE_ROUTING_CONFIG_KEY = "default";

const DEFAULT_ROUTING: VoiceWakeRoutingConfig = {
  version: 1,
  defaultTarget: { mode: "current" },
  routes: [],
  updatedAtMs: 0,
};

type VoiceWakeRoutingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "voicewake_routing_config" | "voicewake_routing_routes"
>;

function openStateDatabase(stateDir?: string) {
  return openOpenClawStateDatabase({
    env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env,
  });
}

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

function isCanonicalAgentSessionKey(value: string): boolean {
  const trimmed = value.trim();
  if (classifySessionKeyShape(trimmed) !== "agent") {
    return false;
  }
  return !trimmed.split(":").some((part) => part.length === 0);
}

function validateRouteTargetInput(
  value: unknown,
  label: string,
): { ok: true } | { ok: false; message: string } {
  if (!isPlainObject(value)) {
    return { ok: false, message: `${label} must be an object` };
  }
  const rec = value as { mode?: unknown; agentId?: unknown; sessionKey?: unknown };
  const mode = normalizeOptionalString(rec.mode);
  const agentId = normalizeOptionalString(rec.agentId);
  const sessionKey = normalizeOptionalString(rec.sessionKey);
  if (mode !== undefined) {
    if (mode !== "current") {
      return {
        ok: false,
        message: `${label}.mode must be "current" when provided`,
      };
    }
    if (agentId !== undefined || sessionKey !== undefined) {
      return {
        ok: false,
        message: `${label} cannot mix mode with agentId or sessionKey`,
      };
    }
    return { ok: true };
  }
  if (agentId !== undefined && sessionKey !== undefined) {
    return {
      ok: false,
      message: `${label} cannot include both agentId and sessionKey`,
    };
  }
  if (agentId !== undefined) {
    if (!isValidAgentId(agentId)) {
      return {
        ok: false,
        message: `${label}.agentId must be a valid agent id`,
      };
    }
    return { ok: true };
  }
  if (sessionKey !== undefined) {
    if (!isCanonicalAgentSessionKey(sessionKey)) {
      return {
        ok: false,
        message: `${label}.sessionKey must be a canonical agent session key`,
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    message: `${label} must include mode, agentId, or sessionKey`,
  };
}

/** Validate user-provided voice wake routing config before persistence. */
export function validateVoiceWakeRoutingConfigInput(
  input: unknown,
): { ok: true } | { ok: false; message: string } {
  if (!isPlainObject(input)) {
    return { ok: false, message: "config must be an object" };
  }
  const rec = input as {
    defaultTarget?: unknown;
    routes?: unknown;
  };
  if (rec.defaultTarget !== undefined) {
    const validatedDefaultTarget = validateRouteTargetInput(
      rec.defaultTarget,
      "config.defaultTarget",
    );
    if (!validatedDefaultTarget.ok) {
      return validatedDefaultTarget;
    }
  }
  if (rec.routes !== undefined && !Array.isArray(rec.routes)) {
    return { ok: false, message: "config.routes must be an array" };
  }
  if (Array.isArray(rec.routes)) {
    if (rec.routes.length > MAX_VOICEWAKE_ROUTES) {
      return {
        ok: false,
        message: `config.routes must contain at most ${MAX_VOICEWAKE_ROUTES} entries`,
      };
    }
    const normalizedTriggers = new Map<string, number>();
    for (const [index, route] of rec.routes.entries()) {
      if (!isPlainObject(route)) {
        return { ok: false, message: `config.routes[${index}] must be an object` };
      }
      const trigger = normalizeOptionalString(route.trigger);
      const normalizedTrigger = trigger ? normalizeVoiceWakeTriggerWord(trigger) : "";
      if (!trigger || !normalizedTrigger) {
        return {
          ok: false,
          message: `config.routes[${index}].trigger must be a non-empty string`,
        };
      }
      if (trigger.length > MAX_VOICEWAKE_TRIGGER_LENGTH) {
        return {
          ok: false,
          message: `config.routes[${index}].trigger must be at most ${MAX_VOICEWAKE_TRIGGER_LENGTH} characters`,
        };
      }
      const duplicateIndex = normalizedTriggers.get(normalizedTrigger);
      if (duplicateIndex !== undefined) {
        return {
          ok: false,
          message: `config.routes[${index}].trigger duplicates config.routes[${duplicateIndex}].trigger after normalization`,
        };
      }
      normalizedTriggers.set(normalizedTrigger, index);
      const validatedTarget = validateRouteTargetInput(
        route.target,
        `config.routes[${index}].target`,
      );
      if (!validatedTarget.ok) {
        return validatedTarget;
      }
    }
  }
  return { ok: true };
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

function targetColumns(target: VoiceWakeRouteTarget): {
  targetAgentId: string | null;
  targetMode: string;
  targetSessionKey: string | null;
} {
  if ("agentId" in target && target.agentId) {
    return { targetAgentId: target.agentId, targetMode: "agent", targetSessionKey: null };
  }
  if ("sessionKey" in target && target.sessionKey) {
    return { targetAgentId: null, targetMode: "session", targetSessionKey: target.sessionKey };
  }
  return { targetAgentId: null, targetMode: "current", targetSessionKey: null };
}

function targetFromColumns(params: {
  agentId: string | null;
  mode: string;
  sessionKey: string | null;
}): VoiceWakeRouteTarget {
  if (params.mode === "agent" && params.agentId) {
    return { agentId: params.agentId };
  }
  if (params.mode === "session" && params.sessionKey) {
    return { sessionKey: params.sessionKey };
  }
  return { mode: "current" };
}

/** Load persisted voice wake routing config from state. */
export async function loadVoiceWakeRoutingConfig(
  baseDir?: string,
): Promise<VoiceWakeRoutingConfig> {
  const database = openStateDatabase(baseDir);
  const routingDb = getNodeSqliteKysely<VoiceWakeRoutingDatabase>(database.db);
  const configRow = executeSqliteQueryTakeFirstSync(
    database.db,
    routingDb
      .selectFrom("voicewake_routing_config")
      .selectAll()
      .where("config_key", "=", VOICEWAKE_ROUTING_CONFIG_KEY),
  );
  if (!configRow) {
    return { ...DEFAULT_ROUTING };
  }
  const routeRows = executeSqliteQuerySync(
    database.db,
    routingDb
      .selectFrom("voicewake_routing_routes")
      .selectAll()
      .where("config_key", "=", VOICEWAKE_ROUTING_CONFIG_KEY)
      .orderBy("position", "asc"),
  ).rows;
  return {
    version: 1,
    defaultTarget: targetFromColumns({
      agentId: configRow.default_target_agent_id,
      mode: configRow.default_target_mode,
      sessionKey: configRow.default_target_session_key,
    }),
    routes: routeRows.map((row) => ({
      trigger: row.trigger,
      target: targetFromColumns({
        agentId: row.target_agent_id,
        mode: row.target_mode,
        sessionKey: row.target_session_key,
      }),
    })),
    updatedAtMs: configRow.updated_at_ms,
  };
}

/** Persist normalized voice wake routing config. */
export async function setVoiceWakeRoutingConfig(
  config: unknown,
  baseDir?: string,
): Promise<VoiceWakeRoutingConfig> {
  const normalized = normalizeVoiceWakeRoutingConfig(config);
  const updatedAtMs = Date.now();
  const next: VoiceWakeRoutingConfig = {
    ...normalized,
    updatedAtMs,
  };
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const routingDb = getNodeSqliteKysely<VoiceWakeRoutingDatabase>(db);
      executeSqliteQuerySync(
        db,
        routingDb
          .deleteFrom("voicewake_routing_routes")
          .where("config_key", "=", VOICEWAKE_ROUTING_CONFIG_KEY),
      );
      executeSqliteQuerySync(
        db,
        routingDb
          .deleteFrom("voicewake_routing_config")
          .where("config_key", "=", VOICEWAKE_ROUTING_CONFIG_KEY),
      );
      const defaultTarget = targetColumns(next.defaultTarget);
      executeSqliteQuerySync(
        db,
        routingDb.insertInto("voicewake_routing_config").values({
          config_key: VOICEWAKE_ROUTING_CONFIG_KEY,
          version: 1,
          default_target_mode: defaultTarget.targetMode,
          default_target_agent_id: defaultTarget.targetAgentId,
          default_target_session_key: defaultTarget.targetSessionKey,
          updated_at_ms: updatedAtMs,
        }),
      );
      if (next.routes.length > 0) {
        executeSqliteQuerySync(
          db,
          routingDb.insertInto("voicewake_routing_routes").values(
            next.routes.map((route, position) => {
              const target = targetColumns(route.target);
              return {
                config_key: VOICEWAKE_ROUTING_CONFIG_KEY,
                position,
                trigger: route.trigger,
                target_mode: target.targetMode,
                target_agent_id: target.targetAgentId,
                target_session_key: target.targetSessionKey,
                updated_at_ms: updatedAtMs,
              };
            }),
          ),
        );
      }
    },
    baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {},
  );
  return next;
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
