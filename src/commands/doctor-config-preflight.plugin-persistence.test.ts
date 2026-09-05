import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import * as migrationCheckpoint from "../infra/startup-migration-checkpoint.js";
import { migrateLegacyConfigMachineState } from "../infra/state-migrations.config-machine-state.js";
import { readBundledDiscoveryModeMemoized } from "../plugins/bundled-discovery-state.js";
import {
  getCurrentPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { writePersistedInstalledPluginIndexWithLeaseSync } from "../plugins/installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store.js";
import {
  createPluginCache,
  getPluginCache,
  getPluginMetadataSnapshotCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveMigrationCheckpointIdentity } from "./doctor-config-preflight-checkpoint.js";
import {
  persistRefreshedPluginIndex,
  readDoctorConfigPreflightSnapshot,
  type DoctorConfigPreflightPluginSnapshotRead,
} from "./doctor-config-preflight-plugin-index.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { createDoctorPluginMetadataSnapshotScope } from "./doctor/shared/plugin-metadata-snapshot-scope.js";

async function withPreflightPluginFixture(
  run: (
    writeVersion: (version: string) => Promise<void>,
    config: OpenClawConfig,
    workspaces: Record<string, string>,
  ) => Promise<void>,
  workspaceNames: string[] = [],
  fixturePluginId = "preflight-fixture",
) {
  await withDoctorConfigPreflightHome(async (home) => {
    // Scope real discovery to the synthetic plugins owned by this fixture.
    const bundledRoot = path.join(home, "bundled");
    await fs.mkdir(bundledRoot, { recursive: true });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
    const workspaces = Object.fromEntries(
      workspaceNames.map((name) => [name, path.join(home, name)]),
    );
    const plugins = workspaceNames.length
      ? workspaceNames.map((name) => ({
          id: `preflight-${name}`,
          root: path.join(workspaces[name]!, ".openclaw", "extensions", `preflight-${name}`),
        }))
      : [{ id: fixturePluginId, root: path.join(home, "fixture-plugin") }];
    for (const { root } of plugins) {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "index.js"), 'throw new Error("metadata executed");');
    }
    const writeVersion = async (version: string) => {
      for (const { id, root } of plugins) {
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({
            name: id,
            version,
            openclaw: { extensions: ["./index.js"] },
          }),
        );
        await fs.writeFile(
          path.join(root, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            version,
            configSchema: { type: "object", properties: { label: { type: "string" } } },
          }),
        );
      }
    };
    await writeVersion("1.0.0");
    const config: OpenClawConfig = {
      ...(workspaceNames.length
        ? {
            agents: {
              ownership: "explicit",
              // The selected execution owner deliberately differs from the aggregate's first scope.
              defaults: { systemAgent: { agentId: workspaceNames[1] } },
              entries: Object.fromEntries(
                workspaceNames.map((name) => [name, { workspace: workspaces[name] }]),
              ),
            },
          }
        : {}),
      plugins: {
        allow: plugins.map(({ id }) => id),
        ...(workspaceNames.length
          ? {
              slots: { memory: "none" },
              entries: Object.fromEntries(plugins.map(({ id }) => [id, { enabled: true }])),
            }
          : { load: { paths: plugins.map(({ root }) => root) } }),
      },
    };
    await writeOpenClawConfig(home, config);
    // Non-pristine state requires index persistence even though this fixture has no migrations.
    openOpenClawStateDatabase({ env: process.env });
    await run(writeVersion, config, workspaces);
  });
}

const readPluginPreflight = () =>
  readDoctorConfigPreflightSnapshot({
    allowCurrentPluginMetadata: true,
    includePluginMetadata: true,
    preparePluginMetadataSnapshot: true,
    skipPluginValidation: false,
    observe: false,
  });

describe("Doctor plugin persistence", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it.each([
    { scope: "process", replaceBeforeLease: false },
    { scope: "operation", replaceBeforeLease: false },
    { scope: "operation", replaceBeforeLease: true },
  ])(
    "verifies a persisted registry in the $scope scope (replacement before lease: $replaceBeforeLease)",
    async ({ scope, replaceBeforeLease }) => {
      await withPreflightPluginFixture(async (writeVersion) => {
        const checkpointStatus = vi.spyOn(migrationCheckpoint, "readMigrationCheckpointStatus");
        onTestFinished(() => checkpointStatus.mockRestore());
        const run = async () => {
          const owner = getPluginCache();
          const read = readPluginPreflight;
          const initial = await read();
          expect(initial.pluginMetadataSnapshot?.registrySource).toBe("derived");
          expect(
            initial.pluginMetadataSnapshot?.manifestRegistry.plugins.map((p) => p.id),
          ).toContain("preflight-fixture");
          const siblingLease = replaceBeforeLease
            ? migrationCheckpoint.acquireStartupMigrationLease()
            : undefined;
          let replaced = false;
          try {
            const result = await runDoctorConfigPreflight({
              migrateState: false,
              migrateLegacyConfig: false,
              requireStateMigrationCheckpoint: true,
              preparePluginMetadataSnapshot: true,
              observe: false,
              measure: async (name, operation) => {
                const measured = await operation();
                if (
                  name === "doctor.config-preflight.config-snapshot" &&
                  siblingLease &&
                  !replaced
                ) {
                  // Another owner commits after the initial read, before preflight acquires its lease.
                  replaced = true;
                  await writeVersion("2.0.0");
                  await withPluginCache(createPluginCache(), async () => {
                    const latest = await read();
                    expect(latest.pluginMetadataSnapshot).toBeDefined();
                    writePersistedInstalledPluginIndexWithLeaseSync(
                      latest.pluginMetadataSnapshot!.index,
                      {
                        env: process.env,
                        lease: siblingLease,
                      },
                    );
                  });
                  siblingLease.release();
                }
                return measured;
              },
            });
            expect(result.pluginMetadataSnapshot?.registrySource).toBe("persisted");
            expect(
              result.pluginMetadataSnapshot?.manifestRegistry.plugins.find(
                (p) => p.id === "preflight-fixture",
              )?.version,
            ).toBe(replaceBeforeLease ? "2.0.0" : "1.0.0");
            if (scope === "operation") {
              expect(getPluginCache()).toBe(owner);
              const retained = (await read()).pluginMetadataSnapshot!;
              expect(getPluginMetadataSnapshotCache(retained)).toBe(owner);
              expect(retained.registrySource).toBe("derived");
              expect(
                retained.manifestRegistry.plugins.find((p) => p.id === "preflight-fixture")
                  ?.version,
              ).toBe("1.0.0");
            }
          } finally {
            siblingLease?.release();
            // A failed selector reread must neither leak the lease nor hide a successful write.
            expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
              false,
            );
            const durable = withPluginCache(createPluginCache(), () =>
              readPersistedInstalledPluginIndexSync({ env: process.env }),
            );
            expect(durable?.plugins.map((p) => p.pluginId)).toContain("preflight-fixture");
          }
        };
        if (scope === "operation") {
          await withPluginCache(createPluginCache(), run);
        } else {
          await run();
        }
        expect(checkpointStatus).not.toHaveBeenCalled();
      });
    },
  );

  it("refreshes an invalidated Doctor scope without replacing the invoking generation", async () => {
    await withPreflightPluginFixture(async (writeVersion) => {
      const owner = createPluginCache();
      await withPluginCache(owner, async () => {
        const initial = await readPluginPreflight();
        let baseSnapshot = initial.pluginMetadataSnapshot;
        const config = initial.snapshot.sourceConfig;
        const scope = createDoctorPluginMetadataSnapshotScope({
          getBaseSnapshot: () => baseSnapshot,
        });
        const readVersion = () =>
          scope.run(
            { config },
            () =>
              getCurrentPluginMetadataSnapshot({ config })?.manifestRegistry.plugins.find(
                (plugin) => plugin.id === "preflight-fixture",
              )?.version,
          );
        expect(readVersion()).toBe("1.0.0");
        await writeVersion("2.0.0");
        expect(readVersion()).toBe("1.0.0");
        baseSnapshot = undefined;
        scope.invalidate();
        expect(readVersion()).toBe("2.0.0");
        expect(getPluginCache()).toBe(owner);
        const retained = (await readPluginPreflight()).pluginMetadataSnapshot!;
        expect(getPluginMetadataSnapshotCache(retained)).toBe(owner);
        expect(
          retained.manifestRegistry.plugins.find((p) => p.id === "preflight-fixture")?.version,
        ).toBe("1.0.0");
      });
    });
  });

  it.each(["alpha", "beta"])(
    "persists the original %s scope while retaining the config-wide inventory",
    async (first) => {
      const names = [first, first === "alpha" ? "beta" : "alpha"];
      await withPreflightPluginFixture(async (writeVersion, config, workspaces) => {
        await withPluginCache(createPluginCache(), async () => {
          const initial = await readPluginPreflight();
          const aggregate = initial.pluginMetadataSnapshot!;
          expect(aggregate.index.workspaceDir).toBe(workspaces[first]);
          expect(
            aggregate.index.plugins
              .filter((p) => p.pluginId.startsWith("preflight-"))
              .map((p) => p.pluginId)
              .toSorted(),
          ).toEqual(["preflight-alpha", "preflight-beta"]);
          const preflight = () =>
            runDoctorConfigPreflight({
              migrateState: false,
              migrateLegacyConfig: false,
              requireStateMigrationCheckpoint: true,
              preparePluginMetadataSnapshot: true,
              observe: false,
              invalidConfigNote: false,
            });
          // The invoking generation remains old; the post-lease read must own the written leaf.
          await writeVersion("2.0.0");
          const result = await preflight().catch((error: unknown) => error);
          expect.soft(result).not.toBeInstanceOf(Error);
          expect.soft(result).toMatchObject({
            pluginMetadataSnapshot: {
              registrySource: "persisted",
              plugins: expect.arrayContaining(
                names.map((name) =>
                  expect.objectContaining({
                    id: `preflight-${name}`,
                    version: "2.0.0",
                  }),
                ),
              ),
            },
          });
          const durable = withPluginCache(createPluginCache(), () =>
            readPersistedInstalledPluginIndexSync({ env: process.env }),
          );
          expect.soft(durable?.workspaceDir).toBe(workspaces[first]);
          expect
            .soft(
              durable?.plugins
                .filter((p) => p.pluginId.startsWith("preflight-"))
                .map((p) => p.pluginId),
            )
            .toEqual([`preflight-${first}`]);
          expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
            false,
          );

          // Discriminating control: the exact original leaf is accepted by the same selector/preflight.
          const leaf = withPluginCache(createPluginCache(), () =>
            resolvePluginMetadataSnapshot({
              config,
              env: process.env,
              workspaceDir: workspaces[first],
              allowCurrent: false,
            }),
          );
          const lease = migrationCheckpoint.acquireStartupMigrationLease();
          try {
            writePersistedInstalledPluginIndexWithLeaseSync(leaf.index, {
              env: process.env,
              lease,
            });
          } finally {
            lease.release();
          }
          const control = await preflight();
          expect(control.pluginMetadataSnapshot?.registrySource).toBe("persisted");
          expect(
            control.pluginMetadataSnapshot?.plugins
              .filter((p) => p.id.startsWith("preflight-"))
              .map((p) => p.id)
              .toSorted(),
          ).toEqual(["preflight-alpha", "preflight-beta"]);
          expect(
            (await readPluginPreflight()).pluginMetadataSnapshot?.plugins.find(
              (p) => p.id === `preflight-${first}`,
            )?.version,
          ).toBe("1.0.0");
        });
      }, names);
    },
  );

  it.each(["secondary-schema", "duplicate-owner"])(
    "keeps full config-wide validation before persistence (%s)",
    async (failure) => {
      await withPreflightPluginFixture(
        async (_writeVersion, config, workspaces) => {
          if (failure === "secondary-schema") {
            config.plugins!.entries!["preflight-beta"]!.config = { label: 17 };
            const current = await readPluginPreflight();
            await fs.writeFile(current.snapshot.path, JSON.stringify(config));
          } else {
            const manifestPath = path.join(
              workspaces.beta!,
              ".openclaw",
              "extensions",
              "preflight-beta",
              "openclaw.plugin.json",
            );
            const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
            await fs.writeFile(
              manifestPath,
              JSON.stringify({ ...manifest, id: "preflight-alpha" }),
            );
          }
          const result = await runDoctorConfigPreflight({
            migrateState: false,
            migrateLegacyConfig: false,
            requireStateMigrationCheckpoint: true,
            preparePluginMetadataSnapshot: true,
            observe: false,
            invalidConfigNote: false,
          });
          expect(result.snapshot.valid).toBe(false);
          expect(result.snapshot.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining(
                failure === "secondary-schema"
                  ? {
                      path: "plugins.entries.preflight-beta.config.label",
                      message: expect.stringContaining("must be string"),
                    }
                  : { message: expect.stringContaining("present in multiple agent workspaces") },
              ),
            ]),
          );
          expect(
            withPluginCache(createPluginCache(), () =>
              readPersistedInstalledPluginIndexSync({ env: process.env }),
            ),
          ).toBeNull();
          expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
            false,
          );
        },
        ["alpha", "beta"],
      );
    },
  );

  it("retains a refreshed Doctor snapshot's creating cache outside that cache", async () => {
    await withPreflightPluginFixture(async (writeVersion, config) => {
      const invoking = createPluginCache();
      await withPluginCache(invoking, async () => {
        await readPluginPreflight();
        await writeVersion("2.0.0");
        let producer: ReturnType<typeof getPluginCache> | undefined;
        const refreshed = await readDoctorConfigPreflightSnapshot({
          allowCurrentPluginMetadata: false,
          includePluginMetadata: true,
          preparePluginMetadataSnapshot: true,
          skipPluginValidation: false,
          observe: false,
          measure: async (_name, operation) => {
            producer ??= getPluginCache();
            return await operation();
          },
        });
        expect(producer).toBeDefined();
        expect(producer).not.toBe(invoking);
        await writeVersion("3.0.0");
        const snapshot = refreshed.pluginMetadataSnapshot!;
        const version = (metadata: typeof snapshot) =>
          metadata.plugins.find((p) => p.id === "preflight-fixture")?.version;
        withPluginCache(createPluginCache(), () => {
          expect.soft(getPluginMetadataSnapshotCache(snapshot) === producer).toBe(true);
          withPluginMetadataSnapshotScope(
            snapshot,
            () => {
              expect.soft(getPluginCache() === producer).toBe(true);
              expect(
                version(
                  resolvePluginMetadataSnapshot({ config, env: process.env, allowCurrent: false }),
                ),
              ).toBe("2.0.0");
            },
            { config, env: process.env },
          );
        });
        expect(getPluginCache()).toBe(invoking);
        expect(version((await readPluginPreflight()).pluginMetadataSnapshot!)).toBe("1.0.0");
      });
    });
  });

  it.each(["derived", "persisted"])(
    "returns the final accepted startup read after bundled discovery migration from a %s registry",
    async (initialSource) => {
      await withPreflightPluginFixture(async (_writeVersion, config) => {
        const original = await readPluginPreflight();
        // Documented per-plugin disablement keeps metadata discoverable without executing index.js.
        config.plugins!.entries = { "preflight-fixture": { enabled: false } };
        await fs.writeFile(original.snapshot.path, JSON.stringify(config));
        await withPluginCache(createPluginCache(), async () => {
          const initial = await readPluginPreflight();
          expect(initial.snapshot.valid).toBe(true);
          expect(initial.pluginMetadataSnapshot?.registrySource).toBe("derived");
          expect(readBundledDiscoveryModeMemoized()).toBeUndefined();
          if (initialSource === "persisted") {
            const lease = migrationCheckpoint.acquireStartupMigrationLease();
            try {
              writePersistedInstalledPluginIndexWithLeaseSync(
                initial.pluginMetadataSnapshot!.index,
                {
                  env: process.env,
                  lease,
                },
              );
            } finally {
              lease.release();
            }
          }
          let acceptedRead: DoctorConfigPreflightPluginSnapshotRead | undefined;
          let beforeConvergenceRead: DoctorConfigPreflightPluginSnapshotRead | undefined;
          let result: Awaited<ReturnType<typeof runDoctorConfigPreflight>> | undefined;
          let failure: string | undefined;
          try {
            // Startup is a new operation; the seeding generation intentionally retains old facts.
            result = await withPluginCache(createPluginCache(), () =>
              runDoctorConfigPreflight({
                migrateState: false,
                migrateLegacyConfig: false,
                beforeStateMigrations: async () => true,
                requireStartupMigrationCheckpoint: true,
                preparePluginMetadataSnapshot: true,
                observe: false,
                measure: async (name, operation) => {
                  if (name === "doctor.config-preflight.plugin-plan") {
                    beforeConvergenceRead = acceptedRead;
                    // The real machine-state migration must finish before startup convergence begins.
                    expect(readBundledDiscoveryModeMemoized()).toBe("compat");
                  }
                  const measured = await operation();
                  if (name === "doctor.config-preflight.fresh-config-guard") {
                    // Exercise the real policy producer at the guarded migration boundary,
                    // without pulling unrelated legacy-store discovery into this regression.
                    const migrated = migrateLegacyConfigMachineState({ config, env: process.env });
                    expect(migrated.changes).toContain(
                      "Migrated plugins.bundledDiscovery → shared SQLite state",
                    );
                  }
                  if (name === "doctor.config-preflight.config-snapshot") {
                    const read = measured as DoctorConfigPreflightPluginSnapshotRead;
                    if (!acceptedRead) {
                      expect(read.pluginMetadataSnapshot?.registrySource).toBe(initialSource);
                    }
                    acceptedRead = read;
                  }
                  return measured;
                },
              }),
            );
          } catch (error) {
            // Keep captured snapshot environments out of failure output.
            failure = error instanceof Error ? error.message : String(error);
          }
          expect.soft(failure).toBeUndefined();
          const policyHash = resolveInstalledPluginIndexPolicyHash(config, process.env);
          expect(readBundledDiscoveryModeMemoized()).toBe("compat");
          expect(policyHash).not.toBe(initial.pluginMetadataSnapshot?.policyHash);
          expect(beforeConvergenceRead).toBeDefined();
          expect(acceptedRead).toBeDefined();
          expect(acceptedRead?.snapshot.raw).toBe(initial.snapshot.raw);
          const durable = withPluginCache(createPluginCache(), () =>
            readPersistedInstalledPluginIndexSync({ env: process.env }),
          );
          expect.soft(durable?.policyHash).toBe(policyHash);
          expect
            .soft(beforeConvergenceRead?.pluginMigrationFingerprint)
            .toBe(acceptedRead?.pluginMigrationFingerprint);
          expect.soft(acceptedRead?.pluginMetadataSnapshot?.registrySource).toBe("persisted");
          expect(result).toBeDefined();
          if (result) {
            // The post-convergence generation, not the preceding persistence read, owns startup.
            expect(result.snapshot === acceptedRead?.snapshot).toBe(true);
            expect(result.baseConfig === acceptedRead?.snapshot.sourceConfig).toBe(true);
            expect(result.pluginMetadataSnapshot === acceptedRead?.pluginMetadataSnapshot).toBe(
              true,
            );
          }
          expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
            false,
          );
        });
      });
    },
  );

  it("refuses persistence verification when package facts change before the durable reread", async () => {
    const fixturePluginId = "preflight-\u001b[31mfixture";
    await withPreflightPluginFixture(
      async (writeVersion) => {
        const snapshotRead = await readPluginPreflight();
        const lease = migrationCheckpoint.acquireStartupMigrationLease();
        try {
          let failure: unknown;
          try {
            await persistRefreshedPluginIndex({
              env: process.env,
              lease,
              snapshotRead,
              measure: async (_name, operation) => await operation(),
              readPersistedSnapshot: async () => {
                await writeVersion("2.0.0");
                return readDoctorConfigPreflightSnapshot({
                  allowCurrentPluginMetadata: false,
                  includePluginMetadata: true,
                  preparePluginMetadataSnapshot: true,
                  skipPluginValidation: false,
                  observe: false,
                });
              },
            });
          } catch (error) {
            failure = error;
          }
          if (!(failure instanceof Error)) {
            throw new Error("expected plugin registry persistence to fail", { cause: failure });
          }
          expect(failure.message).toMatch(
            /differences: preflight-fixture .*persisted source: .*fixture-plugin.*derived source: .*fixture-plugin.*openclaw plugins registry --refresh/u,
          );
          expect(failure.message).not.toContain("\u001b");
        } finally {
          lease.release();
        }
        expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
          false,
        );
      },
      [],
      fixturePluginId,
    );
  });
  it.each([
    { buildIdentity: "2026-08-28T00:00:00.000Z", interrupted: false },
    { buildIdentity: "2026-08-28T00:00:00.000Z", interrupted: true },
    { buildIdentity: null, interrupted: false },
  ])(
    "records the state checkpoint only after durable verification (buildIdentity=$buildIdentity, interrupted=$interrupted)",
    async ({ buildIdentity, interrupted }) => {
      await withPreflightPluginFixture(async () => {
        let persisted = false;
        let verified = false;
        let identity: ReturnType<typeof resolveMigrationCheckpointIdentity> = null;
        // Pin the build input, not the result: source-only runtimes intentionally cannot record.
        // Identity, lease, formatting, and SQLite behavior still use the real checkpoint owner.
        const realNeedsCheckpoint = migrationCheckpoint.readMigrationCheckpointStatus;
        const realRecordCheckpoint = migrationCheckpoint.recordSuccessfulStateMigrations;
        const needsCheckpoint = vi
          .spyOn(migrationCheckpoint, "readMigrationCheckpointStatus")
          .mockImplementation((params) => realNeedsCheckpoint({ ...params, buildIdentity }));
        const recordCheckpoint = vi
          .spyOn(migrationCheckpoint, "recordSuccessfulStateMigrations")
          .mockImplementation((params) => realRecordCheckpoint({ ...params, buildIdentity }));
        onTestFinished(() => {
          needsCheckpoint.mockRestore();
          recordCheckpoint.mockRestore();
        });
        const readStateCheckpoint = () => {
          const { db } = openOpenClawStateDatabase({ env: process.env });
          const kysely = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "schema_meta">>(db);
          return executeSqliteQueryTakeFirstSync(
            db,
            kysely
              .selectFrom("schema_meta")
              .select("app_version")
              .where("meta_key", "=", "state-migrations"),
          );
        };
        expect(readStateCheckpoint()).toBeUndefined();
        const operation = runDoctorConfigPreflight({
          migrateLegacyConfig: false,
          requireStateMigrationCheckpoint: true,
          preparePluginMetadataSnapshot: true,
          observe: false,
          invalidConfigNote: false,
          measure: async (name, run) => {
            const result = await run();
            if (name === "doctor.config-preflight.plugin-index-persistence") {
              persisted = true;
            }
            if (name === "doctor.config-preflight.config-snapshot" && persisted) {
              const read = result as DoctorConfigPreflightPluginSnapshotRead;
              identity = resolveMigrationCheckpointIdentity({
                snapshot: read.snapshot,
                baseConfig: read.snapshot.sourceConfig,
                pluginMigrationFingerprint: read.pluginMigrationFingerprint,
              });
              expect(read.pluginMetadataSnapshot?.registrySource).toBe("persisted");
              expect(migrationCheckpoint.readMigrationCheckpointStatus({ identity })).toBe("stale");
              expect(readStateCheckpoint()).toBeUndefined();
              verified = true;
              if (interrupted) {
                throw new Error("verification interrupted");
              }
            }
            return result;
          },
        });
        if (interrupted) {
          // A failed rejection must not serialize the snapshot's captured environment.
          await expect(operation.then(() => undefined)).rejects.toThrow("verification interrupted");
        } else {
          const result = await operation;
          expect(result.pluginMetadataSnapshot?.registrySource).toBe("persisted");
        }
        expect(verified).toBe(true);
        expect(identity).not.toBeNull();
        expect(migrationCheckpoint.hasActiveStartupMigrationLease({ env: process.env })).toBe(
          false,
        );
        const recorded = !interrupted && buildIdentity !== null;
        expect(Boolean(readStateCheckpoint())).toBe(recorded);
        expect(migrationCheckpoint.readMigrationCheckpointStatus({ identity })).toBe(
          recorded ? "state-current" : "stale",
        );
      });
    },
  );
});
