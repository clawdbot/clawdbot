import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { RuntimeTargetIssue } from "../../../../packages/gateway-protocol/src/schema/environments.ts";

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

export type DraftNode = {
  nodeId: string;
  displayName: string;
  platform?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  connected: boolean;
  canExec: boolean;
  canBrowse: boolean;
  issues?: RuntimeTargetIssue[];
};

export type DraftCloudProfile = {
  id: string;
  providerId: string;
  trust?: "persistent" | "disposable";
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
  platform?: string;
  sessionHost?: boolean;
  lastConnectedAtMs?: number;
  lastDisconnectedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
  trust?: "persistent" | "disposable";
  capabilities?: string[];
  issues?: RuntimeTargetIssue[];
};

export type BrowserTarget = { nodeId: string; label: string };

export function draftNodeUpdateIssue(node: DraftNode): RuntimeTargetIssue | undefined {
  return node.issues?.find((issue) => issue.code === "update-required");
}

export function isDraftNodeSessionEligible(node: DraftNode): boolean {
  return node.canExec && node.connected && draftNodeUpdateIssue(node) === undefined;
}

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

export function readDraftNodes(value: unknown): DraftNode[] {
  const rawNodes = Array.isArray(value) ? value : [];
  return rawNodes
    .flatMap((raw) => {
      if (!isRecord(raw)) {
        return [];
      }
      const node = raw as {
        nodeId?: unknown;
        displayName?: unknown;
        platform?: unknown;
        deviceFamily?: unknown;
        modelIdentifier?: unknown;
        remoteIp?: unknown;
        connected?: unknown;
        commands?: unknown;
        issues?: unknown;
      };
      const nodeId = normalizeOptionalString(node.nodeId);
      const commands = Array.isArray(node.commands)
        ? node.commands.filter((command): command is string => typeof command === "string")
        : [];
      if (!nodeId) {
        return [];
      }
      const connected = node.connected === true;
      const canExec = commands.includes("system.run");
      const issues = readRuntimeTargetIssues(node.issues);
      return [
        {
          nodeId,
          displayName: normalizeOptionalString(node.displayName) ?? nodeId,
          platform: normalizeOptionalString(node.platform),
          deviceFamily: normalizeOptionalString(node.deviceFamily),
          modelIdentifier: normalizeOptionalString(node.modelIdentifier),
          remoteIp: normalizeOptionalString(node.remoteIp),
          connected,
          canExec,
          canBrowse: connected && canExec && commands.includes("fs.listDir"),
          ...(issues ? { issues } : {}),
        },
      ];
    })
    .toSorted(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.nodeId.localeCompare(right.nodeId),
    );
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
      const machines = readDraftMachineOptions(profile.machines);
      return [{ id, providerId, trust, ...(machines.length > 0 ? { machines } : {}) }];
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

export function readDraftEnvironments(value: unknown): DraftEnvironment[] {
  return (Array.isArray(value) ? value : [])
    .flatMap<DraftEnvironment>((raw) => {
      if (!raw || typeof raw !== "object") {
        return [];
      }
      const environment = raw as {
        id?: unknown;
        type?: unknown;
        platform?: unknown;
        sessionHost?: unknown;
        lastConnectedAtMs?: unknown;
        lastDisconnectedAtMs?: unknown;
        lastSeenAtMs?: unknown;
        lastSeenReason?: unknown;
        trust?: unknown;
        capabilities?: unknown;
        issues?: unknown;
      };
      const id = normalizeOptionalString(environment.id);
      const type = normalizeOptionalString(environment.type);
      if (!id || (type !== "local" && type !== "node" && type !== "worker")) {
        return [];
      }
      const platform = normalizeOptionalString(environment.platform);
      const trust: DraftEnvironment["trust"] =
        environment.trust === "persistent" || environment.trust === "disposable"
          ? environment.trust
          : undefined;
      const capabilities = normalizeArrayBackedTrimmedStringList(environment.capabilities);
      const lastConnectedAtMs = normalizeTimestamp(environment.lastConnectedAtMs);
      const lastDisconnectedAtMs = normalizeTimestamp(environment.lastDisconnectedAtMs);
      const lastSeenAtMs = normalizeTimestamp(environment.lastSeenAtMs);
      const lastSeenReason = normalizeOptionalString(environment.lastSeenReason);
      const issues = readRuntimeTargetIssues(environment.issues);
      return [
        {
          id,
          type,
          ...(platform ? { platform } : {}),
          ...(typeof environment.sessionHost === "boolean"
            ? { sessionHost: environment.sessionHost }
            : {}),
          ...(lastConnectedAtMs !== undefined ? { lastConnectedAtMs } : {}),
          ...(lastDisconnectedAtMs !== undefined ? { lastDisconnectedAtMs } : {}),
          ...(lastSeenAtMs !== undefined ? { lastSeenAtMs } : {}),
          ...(lastSeenReason ? { lastSeenReason } : {}),
          ...(trust ? { trust } : {}),
          ...(capabilities ? { capabilities } : {}),
          ...(issues ? { issues } : {}),
        },
      ];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
