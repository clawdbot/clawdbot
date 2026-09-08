import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentsListResult } from "../api/types.ts";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
import type { SessionGroupSettings } from "../lib/sessions/custom-groups.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";
const BOOT_RECORD_MAX_BYTES = 64 * 1024;
const BOOT_RECORD_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
let bootRecordGeneration = 0;

export type BootRecord = {
  version: 2;
  authMethod: string;
  credential: string;
  savedAt: number;
  scope: string;
  profileId: string | null;
  agents: AgentsListResult;
  groups: SessionGroupSettings[];
  sectionOrder: string[];
};

function credentialFingerprint(credential: string | null | undefined): string | null {
  const value = credential?.trim();
  return value ? fnv1aUtf16(value).toString(16) : null;
}

export function resolveBootRecordAuth(
  auth: { method?: string; deviceToken?: string } | undefined,
  token?: string,
): Pick<BootRecord, "authMethod" | "credential"> | null {
  const method = auth?.method;
  if (method !== "token" && method !== "device-token") {
    return null;
  }
  const credential = credentialFingerprint(method === "token" ? token : auth?.deviceToken);
  return credential ? { authMethod: method, credential } : null;
}

function isBootRecord(value: unknown): value is BootRecord {
  if (!isRecord(value) || !isRecord(value.agents)) {
    return false;
  }
  const agents = value.agents;
  return (
    value.version === 2 &&
    (value.authMethod === "token" || value.authMethod === "device-token") &&
    typeof value.credential === "string" &&
    typeof value.savedAt === "number" &&
    Number.isFinite(value.savedAt) &&
    value.savedAt >= 0 &&
    typeof value.scope === "string" &&
    (value.profileId === null || typeof value.profileId === "string") &&
    typeof agents.defaultId === "string" &&
    agents.defaultId.trim().length > 0 &&
    typeof agents.mainKey === "string" &&
    agents.mainKey.trim().length > 0 &&
    (agents.scope === "per-sender" || agents.scope === "global") &&
    Array.isArray(agents.agents) &&
    agents.agents.every((agent: unknown) => isRecord(agent) && typeof agent.id === "string") &&
    Array.isArray(value.groups) &&
    value.groups.every(
      (group: unknown) =>
        isRecord(group) && typeof group.name === "string" && typeof group.position === "number",
    ) &&
    Array.isArray(value.sectionOrder) &&
    value.sectionOrder.every((section: unknown) => typeof section === "string")
  );
}

export function readBootRecord(
  scope: string,
  credentialForMethod: (method: string) => string | null | undefined,
): BootRecord | null {
  const storage = getSafeLocalStorage();
  const key = BOOT_RECORD_PREFIX + scope;
  try {
    const json = storage?.getItem(key);
    if (json == null) {
      return null;
    }
    if (new TextEncoder().encode(json).length <= BOOT_RECORD_MAX_BYTES) {
      const record: unknown = JSON.parse(json);
      if (
        isBootRecord(record) &&
        record.scope === scope &&
        record.credential === credentialFingerprint(credentialForMethod(record.authMethod)) &&
        Date.now() - record.savedAt <= BOOT_RECORD_MAX_AGE
      ) {
        return record;
      }
    }
  } catch {
    // Browser storage is optional; malformed records must never prevent startup.
  }
  try {
    storage?.removeItem(key);
  } catch {}
  return null;
}

export function clearBootRecords(scope?: string): void {
  bootRecordGeneration += 1;
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    if (scope !== undefined) {
      storage.removeItem(BOOT_RECORD_PREFIX + scope);
      return;
    }
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(BOOT_RECORD_PREFIX)) {
        storage.removeItem(key);
      }
    }
  } catch {}
}

let timer: ReturnType<typeof setTimeout> | undefined;
let pending: { record: BootRecord; generation: number } | undefined;

function flushBootRecord(): void {
  clearTimeout(timer);
  timer = undefined;
  const write = pending;
  pending = undefined;
  if (!write || write.generation !== bootRecordGeneration) {
    return;
  }
  const { record } = write;
  const storage = getSafeLocalStorage();
  const key = BOOT_RECORD_PREFIX + record.scope;
  try {
    const agents = {
      ...record.agents,
      agents: record.agents.agents.map((agent) => {
        const identity = agent.identity ? { ...agent.identity } : undefined;
        if (identity) {
          delete identity.avatar;
          delete identity.avatarUrl;
        }
        return { ...agent, identity };
      }),
    };
    const json = JSON.stringify({ ...record, agents });
    if (new TextEncoder().encode(json).length > BOOT_RECORD_MAX_BYTES) {
      storage?.removeItem(key);
    } else {
      storage?.setItem(key, json);
    }
  } catch {
    try {
      storage?.removeItem(key);
    } catch {}
  }
}

export function persistBootRecord(record: BootRecord): void {
  clearTimeout(timer);
  pending = { record, generation: bootRecordGeneration };
  timer = setTimeout(flushBootRecord, 500);
}

if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function" &&
  typeof document !== "undefined" &&
  typeof document.addEventListener === "function"
) {
  window.addEventListener("pagehide", flushBootRecord);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushBootRecord();
    }
  });
}
