import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";

type ActiveMemoryToggleEntry = {
  sessionKey: string;
  disabled: boolean;
  updatedAt: number;
};

const TOGGLE_STATE_FILE = "session-toggles.json";
const SESSION_TOGGLES_NAMESPACE = "session-toggles";
const MAX_TOGGLE_ENTRIES = 10_000;

function resolveToggleStatePath(stateDir: string): string {
  return path.join(stateDir, "plugins", "active-memory", TOGGLE_STATE_FILE);
}

function activeMemoryToggleKey(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey, "utf8").digest("hex");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readLegacyToggleEntries(filePath: string): Promise<ActiveMemoryToggleEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return [];
    }
    const sessions = (parsed as { sessions?: unknown }).sessions;
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
      return [];
    }
    const entries: ActiveMemoryToggleEntry[] = [];
    for (const [sessionKey, value] of Object.entries(sessions)) {
      if (!sessionKey.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      if ((value as { disabled?: unknown }).disabled !== true) {
        continue;
      }
      const updatedAt =
        typeof (value as { updatedAt?: unknown }).updatedAt === "number"
          ? (value as { updatedAt: number }).updatedAt
          : Date.now();
      entries.push({ sessionKey, disabled: true, updatedAt });
    }
    return entries;
  } catch {
    return [];
  }
}

async function archiveLegacySource(params: {
  filePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated ${params.label} source in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived ${params.label} legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving ${params.label} legacy source: ${String(err)}`);
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "active-memory-session-toggles-json-to-plugin-state",
    label: "Active Memory session toggles",
    async detectLegacyState(params) {
      const filePath = resolveToggleStatePath(params.stateDir);
      const entries = await readLegacyToggleEntries(filePath);
      if (entries.length === 0) {
        return null;
      }
      return {
        preview: [
          `- Active Memory session toggles: ${entries.length} ${entries.length === 1 ? "entry" : "entries"} -> plugin state (${SESSION_TOGGLES_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = resolveToggleStatePath(params.stateDir);
      const entries = await readLegacyToggleEntries(filePath);
      if (entries.length === 0) {
        return { changes, warnings };
      }
      const store = params.context.openPluginStateKeyedStore<ActiveMemoryToggleEntry>({
        namespace: SESSION_TOGGLES_NAMESPACE,
        maxEntries: MAX_TOGGLE_ENTRIES,
      });
      const existingKeys = new Set((await store.entries()).map((entry) => entry.key));
      const missingEntries = entries.filter(
        (entry) => !existingKeys.has(activeMemoryToggleKey(entry.sessionKey)),
      );
      if (missingEntries.length > MAX_TOGGLE_ENTRIES - existingKeys.size) {
        warnings.push(
          `Skipped Active Memory session toggle migration because plugin state has room for ${MAX_TOGGLE_ENTRIES - existingKeys.size} of ${missingEntries.length} missing entries; left legacy source in place`,
        );
        return { changes, warnings };
      }
      let imported = 0;
      for (const entry of entries) {
        const key = activeMemoryToggleKey(entry.sessionKey);
        if (existingKeys.has(key)) {
          continue;
        }
        await store.register(key, entry);
        existingKeys.add(key);
        imported++;
      }
      if (imported > 0) {
        changes.push(
          `Migrated ${imported} Active Memory session toggle ${imported === 1 ? "entry" : "entries"} -> plugin state`,
        );
      }
      await archiveLegacySource({
        filePath,
        label: "Active Memory session toggles",
        changes,
        warnings,
      });
      return { changes, warnings };
    },
  },
];
