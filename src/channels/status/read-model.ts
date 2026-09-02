// Read-model helpers that merge gateway channel status with local config snapshots.
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { hasConfiguredUnavailableCredentialStatus } from "../account-snapshot-fields.js";
import type { ChannelAccountSnapshot } from "../plugins/types.public.js";

export type RuntimeChannelStatusPayload = {
  channelAccounts?: unknown;
};

type RuntimeChannelAccount = Record<string, unknown>;

const CREDENTIAL_STATUS_KEYS = [
  "tokenStatus",
  "botTokenStatus",
  "appTokenStatus",
  "signingSecretStatus",
  "userTokenStatus",
] as const;

function readRuntimeAccountsByChannel(payload: unknown): Record<string, unknown> {
  return asRecord(asRecord(payload).channelAccounts);
}

/** Reads raw runtime account records for one channel from a gateway payload. */
export function getRuntimeChannelAccounts(params: {
  payload: unknown;
  channelId: string;
}): RuntimeChannelAccount[] {
  const raw = readRuntimeAccountsByChannel(params.payload)[params.channelId];
  return Array.isArray(raw) ? raw.map(asRecord) : [];
}

/** Normalizes gateway channel account snapshots into a channel-id map. */
export function normalizeRuntimeChannelAccountSnapshots(
  payload: unknown,
): Map<string, ChannelAccountSnapshot[]> {
  const out = new Map<string, ChannelAccountSnapshot[]>();
  for (const [channelId, accounts] of Object.entries(readRuntimeAccountsByChannel(payload))) {
    if (!Array.isArray(accounts)) {
      continue;
    }
    const normalized = accounts.filter(
      (account): account is ChannelAccountSnapshot =>
        Boolean(account) &&
        typeof account === "object" &&
        typeof (account as { accountId?: unknown }).accountId === "string",
    );
    if (normalized.length > 0) {
      out.set(channelId, normalized);
    }
  }
  return out;
}

/** Resolves a stable account id from runtime status record fallbacks. */
function resolveRuntimeChannelAccountId(account: RuntimeChannelAccount): string {
  return (
    normalizeOptionalString(account.accountId) ??
    normalizeOptionalString(account.id) ??
    normalizeOptionalString(account.name) ??
    DEFAULT_ACCOUNT_ID
  );
}

/** Finds a runtime account, including singleton default-account fallback. */
function findRuntimeChannelAccount(params: {
  liveAccounts: RuntimeChannelAccount[];
  accountId: string;
}): RuntimeChannelAccount | null {
  return (
    params.liveAccounts.find(
      (account) => resolveRuntimeChannelAccountId(account) === params.accountId,
    ) ??
    (params.accountId === DEFAULT_ACCOUNT_ID && params.liveAccounts.length === 1
      ? (params.liveAccounts[0] ?? null)
      : null)
  );
}

/** Reports whether a runtime account has usable live credentials. */
export function hasRuntimeCredentialAvailable(params: {
  liveAccounts: RuntimeChannelAccount[];
  accountId: string;
}): boolean {
  const account = findRuntimeChannelAccount(params);
  if (!account) {
    return false;
  }
  if (hasConfiguredUnavailableCredentialStatus(account)) {
    return false;
  }
  return account.running === true || account.connected === true;
}

/** Converts configured-but-unavailable credential markers to available. */
export function markConfiguredUnavailableCredentialStatusesAvailable(
  account: unknown,
): Record<string, unknown> {
  const record = { ...asRecord(account) };
  for (const key of CREDENTIAL_STATUS_KEYS) {
    if (record[key] === "configured_unavailable") {
      record[key] = "available";
    }
  }
  return record;
}

/** Merges local and runtime accounts into display rows with source metadata. */
export async function resolveChannelAccountStatusRows(params: {
  localAccountIds: string[];
  runtimeAccounts: ChannelAccountSnapshot[];
  resolveLocalSnapshot: (accountId: string) => Promise<ChannelAccountSnapshot>;
}): Promise<
  Array<{
    accountId: string;
    snapshot: ChannelAccountSnapshot;
    source: "gateway" | "config";
  }>
> {
  const mergedAccountIds = uniqueStrings([
    ...params.localAccountIds,
    ...params.runtimeAccounts.map((account) => account.accountId),
  ]);
  const rows: Array<{
    accountId: string;
    snapshot: ChannelAccountSnapshot;
    source: "gateway" | "config";
  }> = [];
  for (const accountId of mergedAccountIds) {
    const runtimeSnapshot = params.runtimeAccounts.find(
      (account) => account.accountId === accountId,
    );
    rows.push({
      accountId,
      snapshot: runtimeSnapshot ?? (await params.resolveLocalSnapshot(accountId)),
      source: runtimeSnapshot ? "gateway" : "config",
    });
  }
  return rows;
}
