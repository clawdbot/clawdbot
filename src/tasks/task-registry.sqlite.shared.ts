// Shares SQLite row mapping helpers between task registry persistence modules.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { isRecord } from "../utils.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export const SQLITE_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

export function normalizeSqliteNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Persisted JSON columns are typed by the receiving field.
export function parseSqliteJsonValue<T>(raw: string | null): T | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function parseDeliveryContextJson(raw: string | null): DeliveryContext | undefined {
  const parsed = parseSqliteJsonValue<unknown>(raw);
  if (!isRecord(parsed)) {
    return undefined;
  }
  return normalizeDeliveryContext({
    channel: typeof parsed.channel === "string" ? parsed.channel : undefined,
    to: typeof parsed.to === "string" ? parsed.to : undefined,
    accountId: typeof parsed.accountId === "string" ? parsed.accountId : undefined,
    threadId:
      typeof parsed.threadId === "string" || typeof parsed.threadId === "number"
        ? parsed.threadId
        : undefined,
  });
}

export function ensureSqliteStorePermissions(params: {
  dir: string;
  pathname: string;
  dirMode: number;
  fileMode: number;
}) {
  mkdirSync(params.dir, { recursive: true, mode: params.dirMode });
  chmodSync(params.dir, params.dirMode);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const candidate = `${params.pathname}${suffix}`;
    if (!existsSync(candidate)) {
      continue;
    }
    chmodSync(candidate, params.fileMode);
  }
}
