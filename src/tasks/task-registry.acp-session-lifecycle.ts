import {
  identityHasStableSessionId,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import type { TaskRecord } from "./task-registry.types.js";

function getAcpSessionParentKeys(acpEntry: Pick<AcpSessionStoreEntry, "entry">): string[] {
  return [
    normalizeOptionalString(acpEntry.entry?.spawnedBy),
    normalizeOptionalString(acpEntry.entry?.parentSessionKey),
  ].filter((value): value is string => Boolean(value));
}

export function isParentOwnedAcpSessionTask(
  task: Pick<TaskRecord, "ownerKey" | "requesterSessionKey">,
  acpEntry: Pick<AcpSessionStoreEntry, "entry"> | undefined,
): boolean {
  if (!acpEntry?.entry) {
    return false;
  }
  const ownerKey = normalizeOptionalString(task.ownerKey);
  const requesterKey = normalizeOptionalString(task.requesterSessionKey);
  return getAcpSessionParentKeys(acpEntry).some(
    (parentKey) => parentKey === ownerKey || parentKey === requesterKey,
  );
}

export function isParentOwnedAcpSessionEntry(
  acpEntry: Pick<AcpSessionStoreEntry, "entry">,
): boolean {
  return getAcpSessionParentKeys(acpEntry).length > 0;
}

export function isResumableOneShotAcpSession(acpEntry: AcpSessionStoreEntry): boolean {
  const identity = resolveSessionIdentityFromMeta(acpEntry.acp);
  return (
    acpEntry.acp?.mode === "oneshot" &&
    identity?.sessionResumeSupported === true &&
    identity.sessionResumeReady === true &&
    identityHasStableSessionId(identity)
  );
}
