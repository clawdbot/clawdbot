import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineLegacyJsonStateMigration } from "../plugin-sdk/runtime-doctor-migrations.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  autoMigrateLegacyPluginDoctorState,
  detectLegacyStateMigrations,
  resetAutoMigrateLegacyStateDirForTest,
} from "./state-migrations.js";

const registry = vi.hoisted(() => ({
  entries: [] as Array<{ pluginId: string; migration: PluginDoctorStateMigration }>,
}));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorStateMigrationEntries: () => registry.entries,
  };
});

describe("legacy JSON plugin migration diagnostics", () => {
  let state: OpenClawTestState;
  let sourcePath: string;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "legacy-json-doctor" });
    sourcePath = state.statePath("legacy.json");
    registry.entries = [
      {
        pluginId: "fixture",
        migration: defineLegacyJsonStateMigration({
          id: "fixture-json",
          label: "Fixture legacy state",
          resolvePath: (stateDir) => path.join(stateDir, "legacy.json"),
          parse: (value) => (Array.isArray(value) ? value : null),
          namespace: "legacy",
          maxEntries: 10,
          describeEntries: () => ({
            preview: ["Fixture legacy state"],
            change: () => "Imported fixture legacy state",
          }),
          toRows: (values) => values.map((value, index) => ({ key: String(index), value })),
        }),
      },
    ];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    registry.entries = [];
    resetAutoMigrateLegacyStateDirForTest();
    await state.cleanup();
  });

  describe.each(["detection", "migration"] as const)("%s", (phase) => {
    it.each([
      { fault: "EACCES", expectedError: "EACCES" },
      { fault: "EIO", expectedError: "EIO" },
      { fault: "invalid JSON", expectedError: "SyntaxError" },
      { fault: "ENOENT", expectedError: null },
      { fault: "unrecognized shape", expectedError: null },
    ])(
      "reports $fault without importing or archiving the source",
      async ({ fault, expectedError }) => {
        const source = fault === "invalid JSON" ? "{" : "{}";
        if (fault !== "ENOENT") {
          await fs.writeFile(sourcePath, source, "utf8");
        }
        const readFile = fs.readFile.bind(fs);
        let sourceReads = 0;
        vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
          if (filePath === sourcePath) {
            sourceReads++;
            // Let detection succeed, then fail the direct migration read.
            if (phase === "migration" && sourceReads === 1) {
              return '[{"disabled":true}]';
            }
            if (fault === "EACCES" || fault === "EIO") {
              throw Object.assign(new Error(`${fault}: read ${sourcePath}`), { code: fault });
            }
          }
          return readFile(filePath, options);
        });

        let warnings: string[];
        if (phase === "detection") {
          const detected = await detectLegacyStateMigrations({
            cfg: {},
            env: state.env,
            homedir: () => state.home,
            pluginSessionStoreAgentIds: [],
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          });
          expect(detected.pluginPlans?.hasLegacy).toBe(false);
          warnings = detected.warnings;
        } else {
          const result = await autoMigrateLegacyPluginDoctorState({
            config: {},
            env: state.env,
            homedir: () => state.home,
          });
          expect(result.changes).toEqual([]);
          expect(sourceReads).toBe(2);
          warnings = result.warnings;
        }

        expect(warnings).toEqual(
          expectedError
            ? [
                expect.stringContaining(
                  `Failed ${phase === "detection" ? "detecting" : "migrating"} Fixture legacy state:`,
                ),
              ]
            : [],
        );
        if (expectedError) {
          expect(warnings[0]).toContain(expectedError);
        }
        if (fault !== "ENOENT") {
          await expect(readFile(sourcePath, "utf8")).resolves.toBe(source);
        }
        await expect(fs.stat(`${sourcePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });
});
