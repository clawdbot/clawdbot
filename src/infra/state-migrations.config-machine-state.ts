// Imports machine-owned openclaw.json values into the shared SQLite state store.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compareOpenClawVersions } from "../config/version.js";
import { clearBundledDiscoveryModeMemo } from "../plugins/bundled-discovery-state.js";
import {
  importConfigMachineState,
  updateConfigMachineState,
} from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";

const BUNDLED_DISCOVERY_STATE_CUTOVER_VERSION = "2026.7.2";

/** Preserve retired machine-owned config fields before Doctor strips them. */
export function migrateLegacyConfigMachineState(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): { changes: string[]; warnings: string[] } {
  const raw = params.config as Record<string, unknown>;
  const entries: Array<readonly [string, unknown]> = [];
  const meta = asOptionalRecord(raw.meta);
  if (meta && Object.hasOwn(meta, "lastTouchedAt")) {
    entries.push(["config.lastTouchedAt", meta.lastTouchedAt]);
  }
  const installs = asOptionalRecord(
    asOptionalRecord(asOptionalRecord(raw.hooks)?.internal)?.installs,
  );
  const hasInstalls = Boolean(installs && Object.keys(installs).length > 0);
  const plugins = asOptionalRecord(raw.plugins);
  if (plugins && Object.hasOwn(plugins, "bundledDiscovery")) {
    entries.push(["plugins.bundledDiscovery", plugins.bundledDiscovery]);
  } else if (
    Array.isArray(plugins?.allow) &&
    plugins.allow.length > 0 &&
    (typeof meta?.lastTouchedVersion !== "string" ||
      compareOpenClawVersions(meta.lastTouchedVersion, BUNDLED_DISCOVERY_STATE_CUTOVER_VERSION) ===
        -1)
  ) {
    // Only infer compat when the canonical SQLite row does not already exist.
    // Beta versions (e.g. 2026.7.2-beta.5) are treated by SemVer as older than
    // the cutover release (2026.7.2), so the inference re-fires on every new
    // CLI process.  Checking for an existing canonical value here avoids
    // re-reporting the already-preserved state as a Doctor change.
    let hasCanonicalState = false;
    try {
      hasCanonicalState =
        readConfigMachineState("plugins.bundledDiscovery", { env: params.env }) !== undefined;
    } catch {
      // SQLite temporarily unavailable — fall through to infer compat;
      // importConfigMachineState below will handle it.
    }
    if (!hasCanonicalState) {
      entries.push(["plugins.bundledDiscovery", "compat"]);
    }
  }
  const tts = asOptionalRecord(raw.tts);
  if (tts && Object.hasOwn(tts, "prefsPath")) {
    entries.push(["tts.prefsPath", tts.prefsPath]);
  }
  const cron = asOptionalRecord(raw.cron);
  if (cron && Object.hasOwn(cron, "store")) {
    entries.push(["cron.store", cron.store]);
  }
  if (entries.length === 0 && !hasInstalls) {
    return { changes: [], warnings: [] };
  }
  const result = importConfigMachineState(entries, { env: params.env });
  if (entries.some(([key]) => key === "plugins.bundledDiscovery")) {
    // Same-process readers must not keep the pre-migration absent mode cached,
    // or doctor rebuilds plugin indexes against stale strict-gate decisions.
    clearBundledDiscoveryModeMemo();
  }
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
