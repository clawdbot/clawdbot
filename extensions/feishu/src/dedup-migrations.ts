import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BundledChannelLegacyStateMigrationDetector } from "openclaw/plugin-sdk/channel-entry-contract";

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_MAX_ENTRIES = 10_000;

type LegacyDedupeData = Record<string, number>;

function safeNamespaceFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(".json")) {
    return null;
  }
  const namespace = fileName.slice(0, -".json".length).trim();
  return namespace ? namespace : null;
}

function readLegacyDedupeData(filePath: string): LegacyDedupeData {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: LegacyDedupeData = {};
    for (const [messageId, seenAt] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof seenAt === "number" && Number.isFinite(seenAt) && seenAt > 0) {
        out[messageId] = seenAt;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function dedupeStoreKey(namespace: string, messageId: string): string {
  return createHash("sha256")
    .update(`${namespace}\0${messageId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function remainingTtlMs(seenAt: number, now: number): number {
  return Math.max(1, DEDUP_TTL_MS - (now - seenAt));
}

function buildMigrationEntries(namespace: string, sourcePath: string, now: number) {
  return Object.entries(readLegacyDedupeData(sourcePath)).flatMap(([messageId, seenAt]) => {
    if (now - seenAt >= DEDUP_TTL_MS) {
      return [];
    }
    return [
      {
        key: dedupeStoreKey(namespace, messageId),
        value: { namespace, messageId, seenAt },
        ttlMs: remainingTtlMs(seenAt, now),
      },
    ];
  });
}

export const detectFeishuLegacyStateMigrations: BundledChannelLegacyStateMigrationDetector = ({
  stateDir,
}) => {
  const dedupDir = path.join(stateDir, "feishu", "dedup");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dedupDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const now = Date.now();
  return entries.flatMap((entry) => {
    if (!entry.isFile()) {
      return [];
    }
    const namespace = safeNamespaceFromFileName(entry.name);
    if (!namespace) {
      return [];
    }
    const sourcePath = path.join(dedupDir, entry.name);
    const migrationEntries = buildMigrationEntries(namespace, sourcePath, now);
    if (migrationEntries.length === 0) {
      return [];
    }
    return [
      {
        kind: "plugin-state-import" as const,
        label: `Feishu ${namespace} dedupe`,
        sourcePath,
        targetPath: `plugin state:dedup.${namespace}`,
        pluginId: "feishu",
        namespace: `dedup.${namespace}`,
        maxEntries: STORE_MAX_ENTRIES,
        scopeKey: "",
        cleanupSource: "rename" as const,
        readEntries: () => buildMigrationEntries(namespace, sourcePath, now),
      },
    ];
  });
};
