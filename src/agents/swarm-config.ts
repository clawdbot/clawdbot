import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clampNumber } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

type ResolvedSwarmConfig = {
  enabled: boolean;
  maxConcurrent: number;
  maxChildrenPerGroup: number;
  maxTotalPerGroup: number;
  waitTimeoutSecondsMax: number;
  defaultAgentId: string;
};

const DEFAULT_SWARM_CONFIG: ResolvedSwarmConfig = {
  enabled: false,
  maxConcurrent: 8,
  maxChildrenPerGroup: 50,
  maxTotalPerGroup: 200,
  waitTimeoutSecondsMax: 600,
  defaultAgentId: "",
};

function normalizeRawConfig(value: unknown): Record<string, unknown> | undefined {
  if (value === true) {
    return { enabled: true };
  }
  if (value === false) {
    return { enabled: false };
  }
  return isRecord(value) ? value : undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Resolve global and per-agent Swarm configuration into bounded runtime values. */
export function resolveSwarmConfig(config?: OpenClawConfig, agentId?: string): ResolvedSwarmConfig {
  const globalRaw = normalizeRawConfig(config?.tools?.swarm) ?? {};
  const agentRaw =
    config && agentId
      ? normalizeRawConfig(resolveAgentConfig(config, agentId)?.tools?.swarm)
      : undefined;
  const raw = agentRaw ? { ...globalRaw, ...agentRaw } : globalRaw;
  const maxChildrenPerGroup = clampNumber(
    readPositiveInteger(raw.maxChildrenPerGroup, DEFAULT_SWARM_CONFIG.maxChildrenPerGroup),
    1,
    10_000,
  );
  const maxTotalPerGroup = clampNumber(
    readPositiveInteger(raw.maxTotalPerGroup, DEFAULT_SWARM_CONFIG.maxTotalPerGroup),
    1,
    100_000,
  );
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SWARM_CONFIG.enabled,
    maxConcurrent: clampNumber(
      readPositiveInteger(raw.maxConcurrent, DEFAULT_SWARM_CONFIG.maxConcurrent),
      1,
      1_000,
    ),
    maxChildrenPerGroup,
    maxTotalPerGroup,
    waitTimeoutSecondsMax: clampNumber(
      readPositiveInteger(raw.waitTimeoutSecondsMax, DEFAULT_SWARM_CONFIG.waitTimeoutSecondsMax),
      1,
      24 * 60 * 60,
    ),
    defaultAgentId: typeof raw.defaultAgentId === "string" ? raw.defaultAgentId.trim() : "",
  };
}
