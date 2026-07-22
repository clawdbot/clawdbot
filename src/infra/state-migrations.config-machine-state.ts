// Imports machine-owned openclaw.json values into the shared SQLite state store.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compareOpenClawVersions } from "../config/version.js";
import {
  importConfigMachineState,
  updateConfigMachineState,
} from "../state/config-machine-state.js";

const BUNDLED_DISCOVERY_STATE_CUTOVER_VERSION = "2026.7.2";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Preserve retired machine-owned config fields before Doctor strips them. */
export function migrateLegacyConfigMachineState(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): { changes: string[]; warnings: string[] } {
  const raw = params.config as Record<string, unknown>;
  const entries: Array<readonly [string, unknown]> = [];
  const meta = record(raw.meta);
  if (meta && Object.hasOwn(meta, "lastTouchedAt")) {
    entries.push(["config.lastTouchedAt", meta.lastTouchedAt]);
  }
  const installs = record(record(record(raw.hooks)?.internal)?.installs);
  const hasInstalls = Boolean(installs && Object.keys(installs).length > 0);
  const plugins = record(raw.plugins);
  if (plugins && Object.hasOwn(plugins, "bundledDiscovery")) {
    entries.push(["plugins.bundledDiscovery", plugins.bundledDiscovery]);
  } else if (
    Array.isArray(plugins?.allow) &&
    plugins.allow.length > 0 &&
    (typeof meta?.lastTouchedVersion !== "string" ||
      compareOpenClawVersions(meta.lastTouchedVersion, BUNDLED_DISCOVERY_STATE_CUTOVER_VERSION) ===
        -1)
  ) {
    entries.push(["plugins.bundledDiscovery", "compat"]);
  }
  const tts = record(raw.tts);
  if (tts && Object.hasOwn(tts, "prefsPath")) {
    entries.push(["tts.prefsPath", tts.prefsPath]);
  }
  const cron = record(raw.cron);
  if (cron && Object.hasOwn(cron, "store")) {
    entries.push(["cron.store", cron.store]);
  }
  if (entries.length === 0 && !hasInstalls) {
    return { changes: [], warnings: [] };
  }
  const result = importConfigMachineState(entries, { env: params.env });
  const changes = result.imported.map((key) => `Migrated ${key} → shared SQLite state`);
  changes.push(...result.kept.map((key) => `Kept existing shared SQLite ${key} state`));
  if (installs && hasInstalls) {
    updateConfigMachineState<Record<string, unknown>>(
      "hooks.internal.installs",
      (current) => ({ ...installs, ...current }),
      { env: params.env },
    );
    changes.push("Migrated hooks.internal.installs → shared SQLite state");
  }
  return { changes, warnings: [] };
}
