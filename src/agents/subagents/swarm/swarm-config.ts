import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveAgentConfig } from "../../agent-scope-config.js";

type ResolvedSwarmConfig = {
  enabled: boolean;
  maxConcurrent: number;
  maxChildrenPerGroup: number;
  maxTotalPerGroup: number;
  waitTimeoutSecondsMax: number;
  defaultAgentId: string;
};

const DEFAULT_SWARM_CONFIG: ResolvedSwarmConfig = {
  enabled: true,
  maxConcurrent: 8,
  maxChildrenPerGroup: 50,
  maxTotalPerGroup: 200,
  waitTimeoutSecondsMax: 600,
  defaultAgentId: "",
};

function normalizeRawConfig(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "boolean") {
    return { enabled: value };
  }
  return isRecord(value) ? value : undefined;
}

function readBoundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

/** Resolve global and per-agent Swarm configuration into bounded runtime values. */
export function resolveSwarmConfig(config?: OpenClawConfig, agentId?: string): ResolvedSwarmConfig {
  const globalRaw = normalizeRawConfig(config?.tools?.swarm) ?? {};
  const agentRaw =
    config && agentId
      ? normalizeRawConfig(resolveAgentConfig(config, agentId)?.tools?.swarm)
      : undefined;
  const raw = agentRaw ? { ...globalRaw, ...agentRaw } : globalRaw;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SWARM_CONFIG.enabled,
    maxConcurrent: readBoundedPositiveInteger(
      raw.maxConcurrent,
      DEFAULT_SWARM_CONFIG.maxConcurrent,
      1_000,
    ),
    maxChildrenPerGroup: readBoundedPositiveInteger(
      raw.maxChildrenPerGroup,
      DEFAULT_SWARM_CONFIG.maxChildrenPerGroup,
      10_000,
    ),
    maxTotalPerGroup: readBoundedPositiveInteger(
      raw.maxTotalPerGroup,
      DEFAULT_SWARM_CONFIG.maxTotalPerGroup,
      100_000,
    ),
    waitTimeoutSecondsMax: readBoundedPositiveInteger(
      raw.waitTimeoutSecondsMax,
      DEFAULT_SWARM_CONFIG.waitTimeoutSecondsMax,
      24 * 60 * 60,
    ),
    defaultAgentId: typeof raw.defaultAgentId === "string" ? raw.defaultAgentId.trim() : "",
  };
}
