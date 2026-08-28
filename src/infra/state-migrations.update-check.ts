import path from "node:path";
import { importConfigMachineState, readConfigMachineState } from "../state/config-machine-state.js";
import { migrateLegacyJsonState } from "./state-migrations.runtime-state.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const UPDATE_CHECK_STATE_KEY = "update.checkState";
const UPDATE_CHECK_STATE_FIELDS = [
  "lastCheckedAt",
  "lastNotifiedVersion",
  "lastNotifiedTag",
  "lastAvailableVersion",
  "lastAvailableTag",
  "autoInstallId",
  "autoFirstSeenVersion",
  "autoFirstSeenTag",
  "autoFirstSeenAt",
  "autoLastAttemptVersion",
  "autoLastAttemptAt",
  "autoLastSuccessVersion",
  "autoLastSuccessAt",
] as const;
type LegacyUpdateCheckState = Partial<Record<(typeof UPDATE_CHECK_STATE_FIELDS)[number], string>>;

export function resolveLegacyUpdateCheckPath(stateDir: string): string {
  return path.join(stateDir, "update-check.json");
}

function normalizeLegacyUpdateCheckState(input: unknown): LegacyUpdateCheckState {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return Object.fromEntries(
    UPDATE_CHECK_STATE_FIELDS.map((field) => {
      const value = record[field];
      return [field, typeof value === "string" && value.trim().length > 0 ? value : undefined];
    }),
  ) as LegacyUpdateCheckState;
}

function legacyUpdateCheckStateMatches(
  existing: LegacyUpdateCheckState,
  state: LegacyUpdateCheckState,
): boolean {
  return UPDATE_CHECK_STATE_FIELDS.every((field) => state[field] === existing[field]);
}

export function migrateLegacyUpdateCheckState(params: {
  detected: LegacyStateDetection["updateCheck"];
  stateDir: string;
}): MigrationMessages {
  return migrateLegacyJsonState({
    sourcePath: params.detected.sourcePath,
    stateDir: params.stateDir,
    label: "update-check state",
    normalize: normalizeLegacyUpdateCheckState,
    migrate(_db, state) {
      const options = { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } };
      const result = importConfigMachineState([[UPDATE_CHECK_STATE_KEY, state]], options);
      if (result.kept.length > 0) {
        const existing = readConfigMachineState<LegacyUpdateCheckState>(
          UPDATE_CHECK_STATE_KEY,
          options,
        );
        return {
          changes: [],
          ...(existing && legacyUpdateCheckStateMatches(existing, state)
            ? {}
            : {
                notices: [
                  `Kept shared SQLite update-check state because legacy cache differs: ${params.detected.sourcePath}`,
                ],
              }),
        };
      }
      return { changes: ["Migrated update-check state → shared SQLite state"] };
    },
  });
}
