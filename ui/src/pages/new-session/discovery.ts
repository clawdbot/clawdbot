import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

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
};

export type DraftCloudProfile = {
  id: string;
  providerId: string;
  trust?: "persistent" | "disposable";
};

export type DraftEnvironment = {
  id: string;
  type: "local" | "node" | "worker";
  platform?: string;
  sessionHost?: boolean;
  trust?: "persistent" | "disposable";
  capabilities?: string[];
};

export type BrowserTarget = { nodeId: string; label: string };

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
      };
      const nodeId = normalizeOptionalString(node.nodeId);
      const commands = Array.isArray(node.commands)
        ? node.commands.filter((command): command is string => typeof command === "string")
        : [];
      if (!nodeId) {
        return [];
      }
      const connected = node.connected === true;
      const canExec = connected && commands.includes("system.run");
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
          canBrowse: canExec && commands.includes("fs.listDir"),
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
      const profile = raw as { id?: unknown; providerId?: unknown; trust?: unknown };
      const id = normalizeOptionalString(profile.id);
      const providerId = normalizeOptionalString(profile.providerId);
      if (!id || !providerId) {
        return [];
      }
      const trust: DraftCloudProfile["trust"] =
        profile.trust === "persistent" || profile.trust === "disposable"
          ? profile.trust
          : undefined;
      return [{ id, providerId, trust }];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
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
        trust?: unknown;
        capabilities?: unknown;
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
      return [
        {
          id,
          type,
          ...(platform ? { platform } : {}),
          ...(typeof environment.sessionHost === "boolean"
            ? { sessionHost: environment.sessionHost }
            : {}),
          ...(trust ? { trust } : {}),
          ...(capabilities ? { capabilities } : {}),
        },
      ];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
