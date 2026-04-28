import {
  MANAGED_MEMORY_DREAMING_CRON_NAME,
  MANAGED_MEMORY_DREAMING_CRON_TAG,
  MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
} from "../memory-host-sdk/dreaming.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

type UnknownRecord = Record<string, unknown>;

function isManagedDreamingJob(raw: UnknownRecord): boolean {
  const description = normalizeOptionalString(raw.description);
  if (description?.includes(MANAGED_MEMORY_DREAMING_CRON_TAG)) {
    return true;
  }
  const name = normalizeOptionalString(raw.name);
  if (name !== MANAGED_MEMORY_DREAMING_CRON_NAME) {
    return false;
  }
  const payload = (raw.payload as UnknownRecord | undefined) ?? undefined;
  const payloadKind = normalizeOptionalLowercaseString(payload?.kind);
  if (payloadKind === "systemevent") {
    return normalizeOptionalString(payload?.text) === MEMORY_DREAMING_SYSTEM_EVENT_TEXT;
  }
  if (payloadKind === "agentturn") {
    return normalizeOptionalString(payload?.message) === MEMORY_DREAMING_SYSTEM_EVENT_TEXT;
  }
  return false;
}

function isStaleDreamingJob(raw: UnknownRecord): boolean {
  const sessionTarget = normalizeOptionalLowercaseString(raw.sessionTarget);
  if (sessionTarget !== "isolated") {
    return true;
  }
  const payload = (raw.payload as UnknownRecord | undefined) ?? undefined;
  const payloadKind = normalizeOptionalLowercaseString(payload?.kind);
  if (payloadKind !== "agentturn") {
    return true;
  }
  if (payload?.lightContext !== true) {
    return true;
  }
  const delivery = (raw.delivery as UnknownRecord | undefined) ?? undefined;
  const deliveryMode = normalizeOptionalLowercaseString(delivery?.mode);
  if (deliveryMode !== "none") {
    return true;
  }
  return false;
}

function rewriteDreamingJobShape(raw: UnknownRecord): void {
  raw.sessionTarget = "isolated";
  raw.payload = {
    kind: "agentTurn",
    message: MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
    lightContext: true,
  };
  raw.delivery = { mode: "none" };
}

export function migrateLegacyDreamingPayloadShape(jobs: UnknownRecord[]): {
  changed: boolean;
  rewrittenCount: number;
} {
  let rewrittenCount = 0;
  for (const raw of jobs) {
    if (!isManagedDreamingJob(raw)) {
      continue;
    }
    if (!isStaleDreamingJob(raw)) {
      continue;
    }
    rewriteDreamingJobShape(raw);
    rewrittenCount += 1;
  }
  return { changed: rewrittenCount > 0, rewrittenCount };
}

export function countStaleDreamingJobs(jobs: UnknownRecord[]): number {
  let count = 0;
  for (const raw of jobs) {
    if (isManagedDreamingJob(raw) && isStaleDreamingJob(raw)) {
      count += 1;
    }
  }
  return count;
}
