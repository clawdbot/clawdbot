// Phone Control API module exposes the plugin public contract.
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";

type ArmGroup = "camera" | "screen" | "writes" | "all";

type ArmStateFileV1 = {
  version: 1;
  armedAtMs: number;
  expiresAtMs: number | null;
  removedFromDeny: string[];
};

type ArmStateFileV2 = {
  version: 2;
  armedAtMs: number;
  expiresAtMs: number | null;
  group: ArmGroup;
  armedCommands: string[];
  addedToAllow: string[];
  removedFromDeny: string[];
};

type ArmStateFile = ArmStateFileV1 | ArmStateFileV2;

const ARM_STATE_NAMESPACE = "armed";
const ARM_STATE_KEY = "current";

function resolveArmStatePath(stateDir: string): string {
  return path.join(stateDir, "plugins", "phone-control", "armed.json");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseArmState(value: unknown): ArmStateFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const parsed = value as Record<string, unknown>;
  if (parsed.version !== 1 && parsed.version !== 2) {
    return null;
  }
  if (typeof parsed.armedAtMs !== "number") {
    return null;
  }
  if (!(parsed.expiresAtMs === null || typeof parsed.expiresAtMs === "number")) {
    return null;
  }
  if (parsed.version === 1) {
    if (!isStringArray(parsed.removedFromDeny)) {
      return null;
    }
    return {
      version: 1,
      armedAtMs: parsed.armedAtMs,
      expiresAtMs: parsed.expiresAtMs,
      removedFromDeny: parsed.removedFromDeny,
    };
  }
  const group = typeof parsed.group === "string" ? parsed.group : "";
  if (group !== "camera" && group !== "screen" && group !== "writes" && group !== "all") {
    return null;
  }
  if (
    !isStringArray(parsed.armedCommands) ||
    !isStringArray(parsed.addedToAllow) ||
    !isStringArray(parsed.removedFromDeny)
  ) {
    return null;
  }
  return {
    version: 2,
    armedAtMs: parsed.armedAtMs,
    expiresAtMs: parsed.expiresAtMs,
    group,
    armedCommands: parsed.armedCommands,
    addedToAllow: parsed.addedToAllow,
    removedFromDeny: parsed.removedFromDeny,
  };
}

async function readLegacyArmState(filePath: string): Promise<ArmStateFile | null> {
  try {
    return parseArmState(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

async function archiveLegacySource(params: {
  filePath: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated Phone Control armed-state source in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived Phone Control armed-state legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(
      `Failed archiving Phone Control armed-state legacy source: ${String(err)}`,
    );
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "phone-control-armed-json-to-plugin-state",
    label: "Phone Control armed state",
    async detectLegacyState(params) {
      const filePath = resolveArmStatePath(params.stateDir);
      const state = await readLegacyArmState(filePath);
      if (!state) {
        return null;
      }
      return {
        preview: [
          `- Phone Control armed state: ${filePath} -> plugin state (${ARM_STATE_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = resolveArmStatePath(params.stateDir);
      const state = await readLegacyArmState(filePath);
      if (!state) {
        return { changes, warnings };
      }
      const store = params.context.openPluginStateKeyedStore<ArmStateFile>({
        namespace: ARM_STATE_NAMESPACE,
        maxEntries: 1,
      });
      const existing = await store.lookup(ARM_STATE_KEY);
      if (existing) {
        warnings.push("Left Phone Control armed-state source in place because plugin state exists");
        return { changes, warnings };
      }
      await store.register(ARM_STATE_KEY, state);
      changes.push("Migrated Phone Control armed state -> plugin state");
      await archiveLegacySource({ filePath, changes, warnings });
      return { changes, warnings };
    },
  },
];
