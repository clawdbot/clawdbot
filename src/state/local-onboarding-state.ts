// Durable local onboarding ownership; inference configuration alone does not prove setup finished.
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { readConfigMachineState, updateConfigMachineState } from "./config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";

export type LocalOnboardingState = {
  version: 1;
  status: "pending" | "completed";
  runId: string;
  configPath: string;
  workspace: string;
  securityAcknowledgedAt: string;
  startedAtMs: number;
  completedAtMs?: number;
};

function stateKey(configPath: string): string {
  return `onboarding.local.${sha256Hex(path.resolve(configPath))}`;
}

function normalizeState(value: unknown, configPath: string): LocalOnboardingState | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.status !== "pending" && value.status !== "completed") ||
    typeof value.runId !== "string" ||
    !value.runId ||
    value.configPath !== path.resolve(configPath) ||
    typeof value.workspace !== "string" ||
    !value.workspace ||
    typeof value.securityAcknowledgedAt !== "string" ||
    !value.securityAcknowledgedAt.trim() ||
    typeof value.startedAtMs !== "number" ||
    !Number.isFinite(value.startedAtMs) ||
    (value.status === "completed" &&
      (typeof value.completedAtMs !== "number" || !Number.isFinite(value.completedAtMs)))
  ) {
    return undefined;
  }
  return value as LocalOnboardingState;
}

export function readLocalOnboardingState(
  configPath: string,
  database: OpenClawStateDatabaseOptions = {},
): LocalOnboardingState | undefined {
  return normalizeState(readConfigMachineState(stateKey(configPath), database), configPath);
}

/** A replaced config at the same path must never inherit another installation's receipt. */
export function readLocalOnboardingStateForConfig(
  configPath: string,
  config: Pick<OpenClawConfig, "wizard">,
  database: OpenClawStateDatabaseOptions = {},
): LocalOnboardingState | undefined {
  const securityAcknowledgedAt = config.wizard?.securityAcknowledgedAt?.trim();
  if (!securityAcknowledgedAt) {
    return undefined;
  }
  const state = readLocalOnboardingState(configPath, database);
  return state?.securityAcknowledgedAt === securityAcknowledgedAt ? state : undefined;
}

/** Begin exactly at inference's commit boundary so failed probes create no recovery state. */
export function beginLocalOnboarding(params: {
  configPath: string;
  workspace: string;
  securityAcknowledgedAt: string;
  replace?: boolean;
  expectedRunId?: string;
  runId: string;
  nowMs?: number;
  database?: OpenClawStateDatabaseOptions;
}): LocalOnboardingState {
  const securityAcknowledgedAt = params.securityAcknowledgedAt.trim();
  if (!securityAcknowledgedAt) {
    throw new Error("Local onboarding requires its persisted security acknowledgement.");
  }
  const pending: LocalOnboardingState = {
    version: 1,
    status: "pending",
    runId: params.runId,
    configPath: path.resolve(params.configPath),
    workspace: path.resolve(params.workspace),
    securityAcknowledgedAt,
    startedAtMs: params.nowMs ?? Date.now(),
  };
  return updateConfigMachineState<LocalOnboardingState>(
    stateKey(params.configPath),
    (value) => {
      const current = normalizeState(value, params.configPath);
      // Reset may replace only its previously observed receipt. A delayed
      // concurrent run must not reopen either a pending or completed owner.
      if (current && (!params.replace || current.runId !== params.expectedRunId)) {
        return current;
      }
      return pending;
    },
    params.database,
  );
}

/** Complete only the owning run; a stale operation cannot close its replacement. */
export function completeLocalOnboarding(params: {
  configPath: string;
  runId: string;
  nowMs?: number;
  database?: OpenClawStateDatabaseOptions;
}): boolean {
  const current = readLocalOnboardingState(params.configPath, params.database);
  if (current?.runId !== params.runId) {
    return false;
  }
  if (current.status === "completed") {
    return true;
  }
  let completed = false;
  updateConfigMachineState<LocalOnboardingState>(
    stateKey(params.configPath),
    (value) => {
      const latest = normalizeState(value, params.configPath);
      if (!latest) {
        throw new Error("Local onboarding state became invalid before completion.");
      }
      if (latest.runId !== params.runId) {
        return latest;
      }
      completed = true;
      return latest.status === "completed"
        ? latest
        : { ...latest, status: "completed", completedAtMs: params.nowMs ?? Date.now() };
    },
    params.database,
  );
  return completed;
}
