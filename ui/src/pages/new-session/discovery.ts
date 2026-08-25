import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeArrayBackedTrimmedStringList,
  normalizeSortedUniqueTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import type {
  EnvironmentStatus,
  RuntimeTargetIssue,
  WorkerExecutionMode,
  WorkerSlotSummary,
} from "../../../../packages/gateway-protocol/src/schema/environments.ts";

export type DraftBranches = {
  repoRoot: string;
  branches: Array<{ name: string; kind: "local" | "remote" }>;
  defaultBranch?: string;
  headBranch?: string;
};

export type DraftRepositoryState =
  | { kind: "idle" }
  | { kind: "checking"; repoRoot: string }
  | ({ kind: "git" } & DraftBranches)
  | { kind: "direct"; repoRoot: string }
  | { kind: "unavailable"; repoRoot: string };

export type DraftCloudProfile = {
  id: string;
  providerId: string;
  trust?: "persistent" | "disposable";
  executionMode?: WorkerExecutionMode;
  executionModes?: readonly WorkerExecutionMode[];
  machines?: DraftMachineOption[];
};

export type DraftMachineOption = {
  id: string;
  label: string;
  cpu?: number;
  memoryGb?: number;
  default?: boolean;
};

export type DraftEnvironment = {
  id: string;
  type: "local" | "node" | "worker";
  label?: string;
  status: EnvironmentStatus;
  platform?: string;
  sessionHost?: boolean;
  workerSlots?: WorkerSlotSummary;
  lastConnectedAtMs?: number;
  lastDisconnectedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
  trust?: "persistent" | "disposable";
  capabilities?: string[];
  invocableCommands?: string[];
  issues?: RuntimeTargetIssue[];
};

export type BrowserTarget = { nodeId: string; label: string };

function normalizeTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function normalizeMachineSize(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_536
    ? value
    : undefined;
}

function readRuntimeTargetIssues(value: unknown): RuntimeTargetIssue[] | undefined {
  const issues = (Array.isArray(value) ? value : []).flatMap<RuntimeTargetIssue>((raw) => {
    if (!isRecord(raw)) {
      return [];
    }
    return raw.code === "update-required" &&
      raw.action === "update-and-reconnect" &&
      raw.updateCommand === "openclaw update" &&
      raw.headlessReconnectCommand === "openclaw node restart"
      ? [raw as RuntimeTargetIssue]
      : [];
  });
  return issues.length > 0 ? issues : undefined;
}

function readDraftCloudProfileExecutionModes(value: unknown): readonly WorkerExecutionMode[] {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.length === 1 && (value[0] === "worker-turn" || value[0] === "remote-exec")) {
    return [value[0]];
  }
  return value.length === 2 && value[0] === "worker-turn" && value[1] === "remote-exec"
    ? ["worker-turn", "remote-exec"]
    : [];
}

export function draftCloudProfileSupportsExecutionMode(
  profile: DraftCloudProfile,
  executionMode: WorkerExecutionMode,
): boolean {
  return profile.executionModes?.includes(executionMode) === true;
}

export function readDraftCloudProfiles(value: unknown): DraftCloudProfile[] {
  return (Array.isArray(value) ? value : [])
    .flatMap<DraftCloudProfile>((raw) => {
      if (!raw || typeof raw !== "object") {
        return [];
      }
      const profile = raw as {
        id?: unknown;
        providerId?: unknown;
        trust?: unknown;
        executionMode?: unknown;
        executionModes?: unknown;
        machines?: unknown;
      };
      const id = normalizeOptionalString(profile.id);
      const providerId = normalizeOptionalString(profile.providerId);
      if (!id || !providerId) {
        return [];
      }
      const trust: DraftCloudProfile["trust"] =
        profile.trust === "persistent" || profile.trust === "disposable"
          ? profile.trust
          : undefined;
      const executionMode: WorkerExecutionMode | undefined =
        profile.executionMode === "worker-turn" || profile.executionMode === "remote-exec"
          ? profile.executionMode
          : undefined;
      const machines = readDraftMachineOptions(profile.machines);
      return [
        {
          id,
          providerId,
          trust,
          executionMode,
          ...(Object.hasOwn(profile, "executionModes")
            ? { executionModes: readDraftCloudProfileExecutionModes(profile.executionModes) }
            : {}),
          ...(machines.length > 0 ? { machines } : {}),
        },
      ];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function readDraftMachineOptions(value: unknown): DraftMachineOption[] {
  const options = new Map<string, DraftMachineOption>();
  for (const raw of (Array.isArray(value) ? value : []).slice(0, 32)) {
    if (!isRecord(raw)) {
      continue;
    }
    const id = normalizeOptionalString(raw.id);
    const label = normalizeOptionalString(raw.label);
    if (!id || id.length > 128 || !label || label.length > 128 || options.has(id)) {
      continue;
    }
    const cpu = normalizeMachineSize(raw.cpu);
    const memoryGb = normalizeMachineSize(raw.memoryGb);
    options.set(id, {
      id,
      label,
      ...(cpu === undefined ? {} : { cpu }),
      ...(memoryGb === undefined ? {} : { memoryGb }),
      ...(typeof raw.default === "boolean" ? { default: raw.default } : {}),
    });
  }
  return [...options.values()];
}

const ENVIRONMENT_STATUSES = new Set<EnvironmentStatus>([
  "available",
  "unavailable",
  "starting",
  "stopping",
  "error",
]);

function isEnvironmentStatus(value: unknown): value is EnvironmentStatus {
  return typeof value === "string" && ENVIRONMENT_STATUSES.has(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function readWorkerSlots(value: unknown): WorkerSlotSummary | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "total" && key !== "available") ||
    !isSafeInteger(value.total) ||
    !isSafeInteger(value.available)
  ) {
    return undefined;
  }
  const total = value.total;
  const available = value.available;
  return total >= 1 && total <= 1_024 && available >= 0 && available <= total
    ? { total, available }
    : undefined;
}

export function readDraftEnvironments(value: unknown): DraftEnvironment[] {
  return (Array.isArray(value) ? value : [])
    .flatMap<DraftEnvironment>((raw) => {
      if (!raw || typeof raw !== "object") {
        return [];
      }
      const environment = raw as {
        id?: unknown;
        type?: unknown;
        label?: unknown;
        status?: unknown;
        platform?: unknown;
        sessionHost?: unknown;
        workerSlots?: unknown;
        lastConnectedAtMs?: unknown;
        lastDisconnectedAtMs?: unknown;
        lastSeenAtMs?: unknown;
        lastSeenReason?: unknown;
        trust?: unknown;
        capabilities?: unknown;
        invocableCommands?: unknown;
        issues?: unknown;
      };
      const id = normalizeOptionalString(environment.id);
      const type = normalizeOptionalString(environment.type);
      if (
        !id ||
        (type !== "local" && type !== "node" && type !== "worker") ||
        !isEnvironmentStatus(environment.status)
      ) {
        return [];
      }
      const status = environment.status;
      const label = normalizeOptionalString(environment.label);
      const platform = normalizeOptionalString(environment.platform);
      const trust: DraftEnvironment["trust"] =
        environment.trust === "persistent" || environment.trust === "disposable"
          ? environment.trust
          : undefined;
      const capabilities = normalizeArrayBackedTrimmedStringList(environment.capabilities);
      const invocableCommands = Array.isArray(environment.invocableCommands)
        ? normalizeSortedUniqueTrimmedStringList(environment.invocableCommands)
            .filter((command) => command.length <= 128)
            .slice(0, 128)
        : undefined;
      const lastConnectedAtMs = normalizeTimestamp(environment.lastConnectedAtMs);
      const lastDisconnectedAtMs = normalizeTimestamp(environment.lastDisconnectedAtMs);
      const lastSeenAtMs = normalizeTimestamp(environment.lastSeenAtMs);
      const lastSeenReason = normalizeOptionalString(environment.lastSeenReason);
      const issues = readRuntimeTargetIssues(environment.issues);
      const workerSlots = readWorkerSlots(environment.workerSlots);
      return [
        {
          id,
          type,
          status,
          ...(label ? { label } : {}),
          ...(platform ? { platform } : {}),
          ...(typeof environment.sessionHost === "boolean"
            ? { sessionHost: environment.sessionHost }
            : {}),
          ...(workerSlots ? { workerSlots } : {}),
          ...(lastConnectedAtMs !== undefined ? { lastConnectedAtMs } : {}),
          ...(lastDisconnectedAtMs !== undefined ? { lastDisconnectedAtMs } : {}),
          ...(lastSeenAtMs !== undefined ? { lastSeenAtMs } : {}),
          ...(lastSeenReason ? { lastSeenReason } : {}),
          ...(trust ? { trust } : {}),
          ...(capabilities ? { capabilities } : {}),
          ...(invocableCommands ? { invocableCommands } : {}),
          ...(issues ? { issues } : {}),
        },
      ];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
