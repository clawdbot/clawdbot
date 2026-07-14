// Doctor-only import of legacy channel pairing JSON into shared SQLite state.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { CHANNEL_IDS } from "../channels/ids.js";
import { getPairingAdapter } from "../channels/plugins/pairing.js";
import {
  dedupePreserveOrder,
  resolveAllowFromAccountId,
  safeAccountKey,
} from "../pairing/pairing-store-keys.js";
import { updateChannelPairingStateSnapshot } from "../pairing/pairing-store-sqlite.js";
import type { PairingRequest } from "../pairing/pairing-store.js";
import type { PairingChannel } from "../pairing/pairing-store.types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

const PAIRING_SUFFIX = "-pairing.json";
const ALLOW_FROM_SUFFIX = "-allowFrom.json";

export type LegacyChannelPairingStateDetection = {
  sourceDir: string;
  files: string[];
  knownChannelIds: string[];
  defaultAccountIds: Record<string, string>;
  accountIds: Record<string, string[]>;
  hasLegacy: boolean;
};

export function detectLegacyChannelPairingState(params: {
  sourceDir: string;
  configuredChannelIds?: readonly string[];
  configuredDefaultAccountIds?: Readonly<Record<string, string>>;
  configuredAccountIds?: Readonly<Record<string, readonly string[]>>;
}): LegacyChannelPairingStateDetection {
  let directoryEntries: fs.Dirent[] = [];
  try {
    directoryEntries = fs.readdirSync(params.sourceDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  const files = directoryEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(PAIRING_SUFFIX) || entry.name.endsWith(ALLOW_FROM_SUFFIX)),
    )
    .map((entry) => entry.name)
    .toSorted();
  const pairedChannelIds = files
    .filter((filename) => filename.endsWith(PAIRING_SUFFIX))
    .map((filename) => filename.slice(0, -PAIRING_SUFFIX.length));
  const knownChannelIds = dedupePreserveOrder([
    ...CHANNEL_IDS,
    ...(params.configuredChannelIds ?? []),
    ...pairedChannelIds,
  ]).toSorted((left, right) => right.length - left.length || left.localeCompare(right));
  return {
    sourceDir: params.sourceDir,
    files,
    knownChannelIds,
    defaultAccountIds: { ...params.configuredDefaultAccountIds },
    accountIds: Object.fromEntries(
      Object.entries(params.configuredAccountIds ?? {}).map(([channel, accountIds]) => [
        channel,
        dedupePreserveOrder(accountIds.map((accountId) => resolveAllowFromAccountId(accountId))),
      ]),
    ),
    hasLegacy: files.length > 0,
  };
}

function parsePairingFilename(filename: string): PairingChannel | null {
  return filename.endsWith(PAIRING_SUFFIX)
    ? (filename.slice(0, -PAIRING_SUFFIX.length) as PairingChannel)
    : null;
}

function parseAllowFromFilename(
  filename: string,
  knownChannelIds: readonly string[],
  defaultAccountIds: Readonly<Record<string, string>>,
  accountIds: Readonly<Record<string, readonly string[]>>,
):
  | { target: { channel: PairingChannel; accountId: string }; reason?: never }
  | { target: null; reason: "ambiguous" | "unresolved" }
  | null {
  if (!filename.endsWith(ALLOW_FROM_SUFFIX)) {
    return null;
  }
  const stem = filename.slice(0, -ALLOW_FROM_SUFFIX.length);
  const targets: Array<{ channel: PairingChannel; accountId: string }> = [];
  let hasAccountCollision = false;
  for (const channel of knownChannelIds) {
    if (stem === channel) {
      targets.push({
        channel: channel as PairingChannel,
        accountId: normalizeOptionalString(defaultAccountIds[channel]) ?? DEFAULT_ACCOUNT_ID,
      });
      continue;
    }
    if (!stem.startsWith(`${channel}-`)) {
      continue;
    }
    const accountKey = stem.slice(channel.length + 1);
    const matchingAccountIds = (accountIds[channel] ?? []).filter(
      (accountId) => safeAccountKey(accountId) === accountKey,
    );
    if (matchingAccountIds.length === 1 && matchingAccountIds[0]) {
      targets.push({ channel: channel as PairingChannel, accountId: matchingAccountIds[0] });
    } else if (matchingAccountIds.length > 1) {
      hasAccountCollision = true;
    }
  }
  if (hasAccountCollision || targets.length > 1) {
    return { target: null, reason: "ambiguous" };
  }
  return targets[0] ? { target: targets[0] } : { target: null, reason: "unresolved" };
}

function normalizeLegacyPairingRequest(value: unknown): PairingRequest | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = normalizeOptionalString(value.id);
  const code = normalizeOptionalString(value.code);
  const createdAt = normalizeOptionalString(value.createdAt);
  const lastSeenAt = normalizeOptionalString(value.lastSeenAt) ?? createdAt;
  if (!id || !code || !createdAt || !lastSeenAt) {
    return null;
  }
  const meta = isRecord(value.meta)
    ? Object.fromEntries(
        Object.entries(value.meta)
          .map(([key, entry]) => [key, normalizeOptionalString(entry) ?? ""] as const)
          .filter(([, entry]) => Boolean(entry)),
      )
    : undefined;
  return { id, code, createdAt, lastSeenAt, ...(meta && Object.keys(meta).length ? { meta } : {}) };
}

function readLegacyPairingRequests(filePath: string): PairingRequest[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.requests)) {
      return null;
    }
    return parsed.requests.flatMap((entry) => {
      const request = normalizeLegacyPairingRequest(entry);
      return request ? [request] : [];
    });
  } catch {
    return null;
  }
}

function normalizeAllowEntry(channel: PairingChannel, value: unknown): string {
  const raw = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!raw || raw === "*") {
    return "";
  }
  let adapter: ReturnType<typeof getPairingAdapter>;
  try {
    adapter = getPairingAdapter(channel);
  } catch {
    // Doctor must preserve an unknown/external channel's ids even when its runtime is not loaded.
    adapter = null;
  }
  const normalized = adapter?.normalizeAllowEntry ? adapter.normalizeAllowEntry(raw) : raw;
  const entry = normalizeOptionalString(normalized) ?? "";
  return entry === "*" ? "" : entry;
}

function readLegacyAllowFrom(filePath: string, channel: PairingChannel): string[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.allowFrom)
        ? parsed.allowFrom
        : null;
    if (!values) {
      return null;
    }
    return dedupePreserveOrder(
      values.map((value) => normalizeAllowEntry(channel, value)).filter(Boolean),
    );
  } catch {
    return null;
  }
}

function mergePairingRequests(
  current: PairingRequest[],
  legacy: PairingRequest[],
): PairingRequest[] {
  const merged = current.slice();
  const keys = new Set(
    current.map(
      (request) => `${resolveAllowFromAccountId(request.meta?.accountId)}\0${request.id}`,
    ),
  );
  for (const request of legacy) {
    const key = `${resolveAllowFromAccountId(request.meta?.accountId)}\0${request.id}`;
    if (!keys.has(key)) {
      keys.add(key);
      merged.push(request);
    }
  }
  return merged;
}

function removeImportedSource(filePath: string, warnings: string[]): boolean {
  try {
    fs.rmSync(filePath, { force: true });
    return true;
  } catch (err) {
    warnings.push(
      `Imported legacy channel pairing state but failed removing ${filePath}: ${String(err)}`,
    );
    return false;
  }
}

export function migrateLegacyChannelPairingState(params: {
  detected: LegacyChannelPairingStateDetection;
  env: NodeJS.ProcessEnv;
}): { changes: string[]; warnings: string[] } {
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const filename of params.detected.files) {
    const filePath = path.join(params.detected.sourceDir, filename);
    const pairingChannel = parsePairingFilename(filename);
    if (pairingChannel) {
      const requests = readLegacyPairingRequests(filePath);
      if (!requests) {
        warnings.push(`Legacy channel pairing file unreadable; left in place at ${filePath}`);
        continue;
      }
      updateChannelPairingStateSnapshot(pairingChannel, params.env, (state) => {
        state.requests = mergePairingRequests(state.requests, requests);
      });
      removeImportedSource(filePath, warnings);
      changes.push(
        `Migrated ${requests.length} ${pairingChannel} pairing request(s) → shared SQLite state`,
      );
      continue;
    }

    const allowTarget = parseAllowFromFilename(
      filename,
      params.detected.knownChannelIds,
      params.detected.defaultAccountIds,
      params.detected.accountIds,
    );
    if (!allowTarget) {
      continue;
    }
    if (!allowTarget.target) {
      const reason = allowTarget.reason === "ambiguous" ? "ambiguous" : "unresolved";
      warnings.push(
        `Legacy channel allowFrom channel/account is ${reason}; left in place at ${filePath}`,
      );
      continue;
    }
    const entries = readLegacyAllowFrom(filePath, allowTarget.target.channel);
    if (!entries) {
      warnings.push(`Legacy channel allowFrom file unreadable; left in place at ${filePath}`);
      continue;
    }
    const accountId = resolveAllowFromAccountId(allowTarget.target.accountId);
    updateChannelPairingStateSnapshot(allowTarget.target.channel, params.env, (state) => {
      state.allowFrom ??= {};
      state.allowFrom[accountId] = dedupePreserveOrder([
        ...(state.allowFrom[accountId] ?? []),
        ...entries,
      ]);
    });
    removeImportedSource(filePath, warnings);
    changes.push(
      `Migrated ${entries.length} ${allowTarget.target.channel}/${accountId} allowFrom entr${entries.length === 1 ? "y" : "ies"} → shared SQLite state`,
    );
  }
  return { changes, warnings };
}
