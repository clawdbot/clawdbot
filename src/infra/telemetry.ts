import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import { isChannelConfigMetadataKey } from "../channels/config-metadata.js";
import { isBuiltInModelProviderOverlayId } from "../config/model-provider-config.js";
import { resolveIsNixMode } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOfficialExternalProviderPluginIds } from "../plugins/official-external-plugin-catalog.js";
import { isPubliclyKnownPluginId } from "../plugins/plugin-public-identity.js";
import { listEnabledPluginRecords } from "../plugins/plugin-runtime-inventory.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { VERSION } from "../version.js";
import { isTruthyEnvValue } from "./env.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";

const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.openclaw.ai/api/latest-version";
const TELEMETRY_STATE_KEY = "telemetry.updateCheck";
const TELEMETRY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TELEMETRY_FAILURE_BACKOFF_MS = 60 * 1000;
const TELEMETRY_TIMEOUT_MS = 3000;
const TELEMETRY_NOTE_MAX_LENGTH = 500;
const SAFE_FEATURE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

type TelemetrySurface = "gateway" | "cli";

type TelemetryUpdate = {
  version: string;
  note?: string;
};

type TelemetryState = {
  lastPingAt?: number;
  latestVersion?: string;
  note?: string;
};

type TelemetryPayload = {
  schema: 1;
  version: string;
  platform: string;
  node: string;
  surface: TelemetrySurface;
  features: {
    channels: string[];
    providerFamilies: string[];
    plugins: string[];
    pluginsEnabled: number;
    sessionsLast24h: number;
  };
};

type TelemetryStatusReason =
  | "enabled"
  | "automated-environment"
  | "do-not-track"
  | "config-disabled"
  | "never-asked"
  | "update-disabled";

type TelemetryUpdateOptions = {
  surface: TelemetrySurface;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  nowMs?: number;
};

const TelemetryResponseSchema = z.object({
  version: z.string().trim().min(1),
  note: z.string().optional(),
});

let lastFailedAttempt: { at: number; endpoint: string; stateDirectory?: string } | undefined;
let inFlightUpdate: Promise<TelemetryUpdate | null> | undefined;

/**
 * CI jobs are not installs. Left unchecked they outnumber operators by orders of
 * magnitude and make version and platform counts meaningless, and someone else's
 * pipeline should not report to us on every job either. A configured endpoint
 * means the caller is deliberately exercising this path, so it still reports.
 */
function isAutomatedEnvironment(): boolean {
  if (process.env.OPENCLAW_TELEMETRY_ENDPOINT?.trim()) {
    return false;
  }
  return isTruthyEnvValue(process.env.CI);
}

function isUpdateCheckDisabled(config: OpenClawConfig): boolean {
  return (
    config.update?.checkOnStart === false ||
    isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE) ||
    isAutomatedEnvironment() ||
    resolveIsNixMode()
  );
}

function isDoNotTrackEnabled(): boolean {
  const value = process.env.DO_NOT_TRACK?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function countRecentSessions(nowMs: number): number {
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db: database }) => {
        const db =
          getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "session_state_events">>(database);
        const row = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("session_state_events")
            .select((builder) => builder.fn.countAll<number>().as("count"))
            .where("kind", "=", "created")
            .where("occurred_at", ">=", nowMs - TELEMETRY_CHECK_INTERVAL_MS),
        );
        return row?.count ?? 0;
      }) ?? 0
    );
  } catch {
    return 0;
  }
}

function resolveTelemetryEndpoint(): string {
  return process.env.OPENCLAW_TELEMETRY_ENDPOINT?.trim() || DEFAULT_TELEMETRY_ENDPOINT;
}

export function buildTelemetryUserAgent(surface: TelemetrySurface): string {
  return `openclaw/${VERSION} (${process.platform}; node/${process.versions.node}; ${process.arch}; ${surface})`;
}

function readTelemetryState(): TelemetryState {
  try {
    const state = readConfigMachineState<TelemetryState>(TELEMETRY_STATE_KEY);
    return state && isRecord(state) ? state : {};
  } catch {
    return {};
  }
}

export function resolveTelemetryStatus(config: OpenClawConfig): {
  enabled: boolean;
  reason: TelemetryStatusReason;
  endpoint: string;
  lastPingAt?: number;
} {
  let reason: TelemetryStatusReason;
  if (isAutomatedEnvironment()) {
    reason = "automated-environment";
  } else if (isUpdateCheckDisabled(config)) {
    reason = "update-disabled";
  } else if (isDoNotTrackEnabled()) {
    reason = "do-not-track";
  } else if (config.telemetry?.enabled === true) {
    reason = "enabled";
  } else if (config.telemetry?.enabled === false || config.telemetry?.consentedAt) {
    reason = "config-disabled";
  } else {
    reason = "never-asked";
  }

  const { lastPingAt } = readTelemetryState();
  return {
    enabled: reason === "enabled",
    reason,
    endpoint: resolveTelemetryEndpoint(),
    ...(lastPingAt === undefined ? {} : { lastPingAt }),
  };
}

export function buildTelemetryPayload(
  config: OpenClawConfig,
  options: { surface: TelemetrySurface },
): TelemetryPayload {
  const enabledPlugins = listEnabledPluginRecords(config);
  const publicPlugins = enabledPlugins.filter(isPubliclyKnownPluginId);
  const publicChannelIds = new Set(publicPlugins.flatMap((plugin) => plugin.channelIds));
  const channels = Object.entries(config.channels ?? {})
    .filter(
      ([channelId, channelConfig]) =>
        SAFE_FEATURE_NAME.test(channelId) &&
        !isChannelConfigMetadataKey(channelId) &&
        isRecord(channelConfig) &&
        channelConfig.enabled !== false &&
        publicChannelIds.has(channelId),
    )
    .map(([channelId]) => channelId)
    .toSorted();
  const configuredProviders = [
    ...Object.keys(config.models?.providers ?? {}),
    ...Object.values(config.auth?.profiles ?? {}).map((profile) => profile.provider),
    ...collectConfiguredModelRefs(config, { includeChannelModelOverrides: false }).flatMap(
      ({ value }) => {
        const provider = parseModelCatalogRef(value)?.provider;
        return provider ? [provider] : [];
      },
    ),
  ];
  const providerFamilies = [...new Set(configuredProviders)]
    .filter(
      (providerId) =>
        SAFE_FEATURE_NAME.test(providerId) &&
        (isBuiltInModelProviderOverlayId(providerId) ||
          resolveOfficialExternalProviderPluginIds({ providerIds: new Set([providerId]) }).length >
            0),
    )
    .toSorted();
  const plugins = [...new Set(publicPlugins.map((plugin) => plugin.id))]
    .filter((pluginId) => SAFE_FEATURE_NAME.test(pluginId))
    .toSorted();

  return {
    schema: 1,
    version: VERSION,
    platform: `${process.platform}-${process.arch}`,
    node: process.versions.node,
    surface: options.surface,
    features: {
      channels,
      providerFamilies,
      plugins,
      pluginsEnabled: enabledPlugins.length,
      sessionsLast24h: countRecentSessions(Date.now()),
    },
  };
}

export async function checkTelemetryUpdate(
  config: OpenClawConfig,
  options: TelemetryUpdateOptions,
): Promise<TelemetryUpdate | null> {
  if (isUpdateCheckDisabled(config)) {
    return null;
  }

  const state = readTelemetryState();
  const cached = state.latestVersion
    ? { version: state.latestVersion, ...(state.note ? { note: state.note } : {}) }
    : null;
  const nowMs = options.nowMs ?? Date.now();
  const endpoint = resolveTelemetryEndpoint();
  const stateDirectory = process.env.OPENCLAW_STATE_DIR;
  if (
    state.lastPingAt !== undefined &&
    nowMs >= state.lastPingAt &&
    nowMs - state.lastPingAt < TELEMETRY_CHECK_INTERVAL_MS
  ) {
    return cached;
  }

  if (!options.fetchImpl && (process.env.VITEST !== undefined || process.env.NODE_ENV === "test")) {
    return cached;
  }
  if (
    lastFailedAttempt?.endpoint === endpoint &&
    lastFailedAttempt.stateDirectory === stateDirectory &&
    nowMs >= lastFailedAttempt.at &&
    nowMs - lastFailedAttempt.at < TELEMETRY_FAILURE_BACKOFF_MS
  ) {
    return cached;
  }
  if (inFlightUpdate) {
    return inFlightUpdate;
  }

  const sendUpdateCheck = async (): Promise<TelemetryUpdate | null> => {
    try {
      const featureStatsEnabled = config.telemetry?.enabled === true && !isDoNotTrackEnabled();
      const headers: Record<string, string> = {
        "User-Agent": buildTelemetryUserAgent(options.surface),
      };
      const init: RequestInit = {
        method: featureStatsEnabled ? "POST" : "GET",
        headers,
        signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
      };
      if (featureStatsEnabled) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(buildTelemetryPayload(config, { surface: options.surface }));
      }
      const response = await (options.fetchImpl ?? fetch)(endpoint, init);
      if (response.status !== 200) {
        lastFailedAttempt = { at: nowMs, endpoint, stateDirectory };
        return cached;
      }
      const parsed = TelemetryResponseSchema.parse(
        await readProviderJsonResponse(response, "Telemetry update response"),
      );
      const note = parsed.note?.trim().slice(0, TELEMETRY_NOTE_MAX_LENGTH);
      const update = {
        version: parsed.version,
        ...(note ? { note } : {}),
      };
      writeConfigMachineState(TELEMETRY_STATE_KEY, {
        lastPingAt: nowMs,
        latestVersion: update.version,
        ...(update.note ? { note: update.note } : {}),
      });
      lastFailedAttempt = undefined;
      return update;
    } catch {
      lastFailedAttempt = { at: nowMs, endpoint, stateDirectory };
      return cached;
    }
  };

  inFlightUpdate = sendUpdateCheck();
  try {
    return await inFlightUpdate;
  } finally {
    inFlightUpdate = undefined;
  }
}
