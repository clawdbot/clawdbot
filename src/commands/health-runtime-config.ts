/** Detects and renders drift between live Gateway config and its completed source observation. */
import { isDeepStrictEqual } from "node:util";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { getConfigValueAtPath } from "../config/config-paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthSummary, RuntimeConfigHealthSummary } from "../gateway/health/types.js";

const RUNTIME_CONFIG_DRIFT_PATHS = [
  "agents.defaults.model",
  "agents.defaults.models",
  "agents.entries",
  "models",
  "gateway.auth",
  "auth.profiles",
  "auth.order",
  "secrets",
] as const;

type RuntimeConfigDriftState = {
  liveSourceConfig: OpenClawConfig | null;
  hasLiveSnapshot: boolean;
  observedSourceConfig: OpenClawConfig | null;
};

function readPrimaryModelLabel(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  const record = asNullableRecord(value);
  const primary = record?.primary;
  return typeof primary === "string" && primary.trim() ? primary.trim() : null;
}

function resolveDefaultModelLabel(config: OpenClawConfig): string | null {
  const agents = asNullableRecord(config.agents);
  const defaults = asNullableRecord(agents?.defaults);
  // `agents.defaults.model` is the default-model selector; `agents.defaults.models`
  // is a catalog map and never carries a primary label, so it is not consulted.
  return readPrimaryModelLabel(defaults?.model);
}

function listRuntimeConfigDriftPaths(params: {
  liveSourceConfig: OpenClawConfig;
  observedSourceConfig: OpenClawConfig;
}): string[] {
  const driftPaths: string[] = [];
  for (const path of RUNTIME_CONFIG_DRIFT_PATHS) {
    const segments = path.split(".");
    const liveValue = getConfigValueAtPath({ ...params.liveSourceConfig }, segments);
    const observedValue = getConfigValueAtPath({ ...params.observedSourceConfig }, segments);
    if (!isDeepStrictEqual(liveValue, observedValue)) {
      driftPaths.push(path);
    }
  }
  return driftPaths;
}

function buildRuntimeConfigHealthSummary(
  state: RuntimeConfigDriftState,
): RuntimeConfigHealthSummary | undefined {
  const liveSourceConfig = state.liveSourceConfig;
  if (!liveSourceConfig) {
    return state.hasLiveSnapshot
      ? {
          state: "unknown",
          message: "Runtime source config snapshot is unavailable.",
        }
      : undefined;
  }
  if (!state.observedSourceConfig) {
    return {
      state: "unknown",
      liveDefaultModel: resolveDefaultModelLabel(liveSourceConfig),
      message: "Latest completed reload source observation is unavailable.",
    };
  }
  const driftPaths = listRuntimeConfigDriftPaths({
    liveSourceConfig,
    observedSourceConfig: state.observedSourceConfig,
  });
  const liveDefaultModel = resolveDefaultModelLabel(liveSourceConfig);
  const observedDefaultModel = resolveDefaultModelLabel(state.observedSourceConfig);
  return {
    state: driftPaths.length > 0 ? "drift" : "ok",
    liveDefaultModel,
    observedDefaultModel,
    ...(driftPaths.length > 0
      ? {
          driftPaths,
          message:
            "Live gateway runtime config differs from the latest completed reload observation for model/provider/auth paths; restart is required or pending.",
        }
      : {}),
  };
}

/** Formats runtime-config drift for normal text health output. */
export function formatRuntimeConfigHealthLine(summary: HealthSummary): string | null {
  const runtimeConfig = summary.runtimeConfig;
  if (!runtimeConfig) {
    return null;
  }
  if (runtimeConfig.state === "drift") {
    const paths = runtimeConfig.driftPaths?.length
      ? runtimeConfig.driftPaths.join(", ")
      : "model/provider/auth config";
    const modelDetail =
      runtimeConfig.liveDefaultModel || runtimeConfig.observedDefaultModel
        ? `; live=${runtimeConfig.liveDefaultModel ?? "unknown"} observed=${
            runtimeConfig.observedDefaultModel ?? "unknown"
          }`
        : "";
    return `Runtime config: warning (live gateway differs from latest completed reload observation for ${paths}; restart required or pending${modelDetail})`;
  }
  if (runtimeConfig.state === "unknown") {
    // Missing runtime or observed sources must stay visible without blaming the
    // wrong side of the comparison.
    const reason = runtimeConfig.message?.trim() || "config source unavailable";
    return `Runtime config: warning (unknown source: ${reason})`;
  }
  return null;
}

/** Builds the runtime-config diagnostic attached to Gateway health snapshots. */
export function buildRuntimeConfigHealth(
  state: RuntimeConfigDriftState,
): RuntimeConfigHealthSummary | undefined {
  return buildRuntimeConfigHealthSummary(state);
}
