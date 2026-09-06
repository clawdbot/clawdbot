import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { planLegacyConfigForUpdateChannel } from "../../commands/doctor/legacy-config-repair.js";
import { createConfigIO } from "../../config/io.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../../config/test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
} from "./schema-preflight.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import {
  captureOwnedManagedUpdatePreflightContext,
  revalidateUpdateDatabaseContext,
} from "./update-command-managed-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("target-release database schema preflight", () => {
  it.runIf(process.platform !== "win32")(
    "deduplicates caller and managed aliases of one physical database",
    async () => {
      const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-update-union-state-"));
      const aliasRoot = tempDirs.make("openclaw-update-union-alias-");
      const stateAlias = path.join(aliasRoot, "state-link");
      fs.symlinkSync(stateDir, stateAlias, "dir");
      const statePath = openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: stateDir },
      }).path;
      closeOpenClawStateDatabaseForTest();
      const { DatabaseSync } = requireNodeSqlite();
      const state = new DatabaseSync(statePath);
      state.exec("PRAGMA user_version = 9;");
      state.close();
      const config: OpenClawConfig = {};

      const result = await checkTargetDatabaseSchemasForContexts({ state: 3, agent: 11 }, [
        { config, env: { OPENCLAW_STATE_DIR: stateDir } },
        { config, env: { OPENCLAW_STATE_DIR: stateAlias } },
      ]);

      expect(result.incompatible).toEqual([
        expect.objectContaining({ kind: "state", path: statePath, foundVersion: 9 }),
      ]);
      expect(result.indeterminate).toEqual([]);
    },
  );

  it("refuses v2026.8.1 before mutating v2026.7.1-2 shared state when an agent store is unreadable", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-update-7-to-8-state-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const config: OpenClawConfig = { agents: { list: [{ id: "main" }, { id: "worker" }] } };
    const statePath = openOpenClawStateDatabase({ env }).path;
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    unregisterOpenClawAgentDatabase({ agentId: "worker", env, path: agentPath });
    const { DatabaseSync } = requireNodeSqlite();
    const state = new DatabaseSync(statePath);
    state.exec("PRAGMA user_version = 1; UPDATE schema_meta SET schema_version = 1;");
    state.close();
    fs.writeFileSync(agentPath, "damaged v2026.7.1-2 agent store\n");
    const stateBefore = fs.readFileSync(statePath);

    const result = await checkTargetDatabaseSchemasForContexts(
      // Published v2026.8.1 supports state schema 15 and agent schema 19.
      { state: 15, agent: 19 },
      [{ config, env }],
    );

    expect(result.incompatible).toEqual([]);
    expect(result.indeterminate).toEqual([
      expect.objectContaining({ kind: "agent", path: agentPath }),
    ]);
    expect(fs.readFileSync(statePath)).toEqual(stateBefore);
    const inspectedState = new DatabaseSync(statePath, { readOnly: true });
    try {
      expect(inspectedState.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    } finally {
      inspectedState.close();
    }
  });

  it("finds every multi-agent store before refusing a v2026.7.1-2 target", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-update-preflight-state-"));
    const customDir = fs.realpathSync.native(tempDirs.make("openclaw-update-preflight-custom-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main" }, { id: "configured" }] },
    };
    openOpenClawStateDatabase({ env });
    const configuredPath = openOpenClawAgentDatabase({ agentId: "configured", env }).path;
    const unregisteredPath = openOpenClawAgentDatabase({ agentId: "retired", env }).path;
    const registeredCustomPath = openOpenClawAgentDatabase({
      agentId: "registered-custom",
      env,
      path: path.join(customDir, "registered", "openclaw-agent.sqlite"),
    }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    unregisterOpenClawAgentDatabase({ agentId: "retired", env, path: unregisteredPath });

    const before = [configuredPath, unregisteredPath, registeredCustomPath].map((pathname) => ({
      pathname,
      bytes: fs.readFileSync(pathname),
      mtimeNs: fs.statSync(pathname, { bigint: true }).mtimeNs,
    }));
    const result = await checkTargetDatabaseSchemasForContexts(
      // v2026.7.1-2 supports state/agent schema 1. The reported upgrade to
      // v2026.8.1 advances them to state 15 and agent 19.
      { state: 1, agent: 1 },
      [{ config, env }],
    );

    const incompatibleAgentPaths = result.incompatible
      .filter((database) => database.kind === "agent")
      .map((database) => database.path)
      .toSorted();
    expect(incompatibleAgentPaths).toEqual(
      [configuredPath, unregisteredPath, registeredCustomPath].toSorted(),
    );
    expect(result.indeterminate).toEqual([]);
    expect(
      before.map(({ pathname }) => ({
        pathname,
        bytes: fs.readFileSync(pathname),
        mtimeNs: fs.statSync(pathname, { bigint: true }).mtimeNs,
      })),
    ).toEqual(before);
  });

  it("finds configured custom stores without registry rows", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-update-custom-state-"));
    const customDir = fs.realpathSync.native(tempDirs.make("openclaw-update-custom-root-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main" }, { id: "ops" }] },
      session: { store: path.join(customDir, "{agentId}", "sessions.json") },
    };
    openOpenClawStateDatabase({ env });
    const customPaths = ["main", "ops"].map(
      (agentId) =>
        openOpenClawAgentDatabase({
          agentId,
          env,
          path: path.join(customDir, agentId, "openclaw-agent.sqlite"),
        }).path,
    );
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    for (const [index, pathname] of customPaths.entries()) {
      unregisterOpenClawAgentDatabase({
        agentId: index === 0 ? "main" : "ops",
        env,
        path: pathname,
      });
    }

    const result = await checkTargetDatabaseSchemasForContexts({ state: 1, agent: 1 }, [
      { config, env },
    ]);

    expect(result.incompatible.filter((database) => database.kind === "agent")).toEqual(
      expect.arrayContaining(
        customPaths.map((pathname) => expect.objectContaining({ path: pathname })),
      ),
    );
    expect(result.indeterminate).toEqual([]);
  });
});

describe("planned legacy configuration admission", () => {
  it.each(["unchanged", "root edit", "include edit", "different profile"] as const)(
    "preserves original config and fences %s",
    async (scenario) => {
      await withTempHome(async (home) => {
        await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const configPath = await writeOpenClawConfig(home, {
            gateway: { $include: "gateway.json" },
          });
          const includePath = path.join(path.dirname(configPath), "gateway.json");
          fs.writeFileSync(includePath, '{"mode":"local","bind":"localhost"}\n');
          const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath };
          const original = fs.readFileSync(configPath);
          const originalInclude = fs.readFileSync(includePath);
          const { snapshot, writeOptions } = await createConfigIO({
            env,
            observe: false,
          }).readConfigFileSnapshotForWrite();
          expect(snapshot.valid).toBe(false);
          const legacyConfigPlan = planLegacyConfigForUpdateChannel(snapshot, writeOptions);
          expect(legacyConfigPlan).toBeDefined();
          await expect(
            captureTargetDatabaseSchemaContext(env).then(() => true),
          ).rejects.toMatchObject({
            reason: "database-schema-preflight",
          });
          // Exercise the real caller admission forwarding, without inspecting a live service.
          const { contexts } = await withEnvOverride({ OPENCLAW_CONFIG_PATH: configPath }, () =>
            inspectUpdateDatabaseContexts({
              roots: [],
              updateInstallKind: "package",
              shouldRestart: false,
              jsonMode: true,
              timeoutMs: 1_000,
              managedServiceRootRedirect: null,
              legacyConfigPlan,
            }),
          );
          const context = contexts[0]!;
          expect(context.config.gateway?.bind).toBe("loopback");
          expect(context.configSnapshot.valid).toBe(false);
          expect(context.configSnapshot.raw).toBe(original.toString());
          expect(fs.readFileSync(configPath)).toEqual(original);
          expect(fs.readFileSync(includePath)).toEqual(originalInclude);
          expect(fs.existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
          if (scenario === "unchanged") {
            expect((await revalidateUpdateDatabaseContext(context)).config).toEqual(context.config);
          } else if (scenario === "different profile") {
            const otherPath = path.join(path.dirname(configPath), "other.json");
            fs.writeFileSync(otherPath, original);
            await expect(
              captureTargetDatabaseSchemaContext(
                { ...env, OPENCLAW_CONFIG_PATH: otherPath },
                { legacyConfigPlan },
              ).then(() => true),
            ).rejects.toMatchObject({ reason: "database-schema-preflight" });
          } else {
            fs.appendFileSync(scenario === "root edit" ? configPath : includePath, "\n");
            await expect(
              revalidateUpdateDatabaseContext(context).then(() => true),
            ).rejects.toMatchObject({
              reason: "database-schema-preflight",
            });
          }
        });
      });
    },
  );
});

describe("planned migration managed profile isolation", () => {
  it.each([
    "same source",
    "other valid source",
    "other legacy source",
    "other invalid source",
  ] as const)("admits only the owned service's config: %s", async (scenario) => {
    await withTempHome(async (home) => {
      await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const callerPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local", bind: "localhost" },
        });
        const callerEnv = { ...process.env, OPENCLAW_CONFIG_PATH: callerPath };
        const { snapshot, writeOptions } = await createConfigIO({
          env: callerEnv,
          observe: false,
        }).readConfigFileSnapshotForWrite();
        const legacyConfigPlan = planLegacyConfigForUpdateChannel(snapshot, writeOptions);
        expect(legacyConfigPlan).toBeDefined();
        const servicePath =
          scenario === "same source"
            ? callerPath
            : path.join(path.dirname(callerPath), "service.json");
        if (servicePath !== callerPath) {
          fs.writeFileSync(
            servicePath,
            JSON.stringify({
              gateway: {
                mode: "local",
                bind: scenario === "other legacy source" ? "localhost" : "lan",
                ...(scenario === "other invalid source" ? { port: "invalid" } : {}),
              },
            }),
          );
        }
        const before = fs.readFileSync(servicePath);
        const serviceEnv = { ...callerEnv, OPENCLAW_CONFIG_PATH: servicePath };
        const originalEnv = { ...process.env };
        const inspected = captureOwnedManagedUpdatePreflightContext({
          processEnv: callerEnv,
          legacyConfigPlan,
          stopState: {
            stopped: false,
            inspected: true,
            runtimeInspected: true,
            running: true,
            serviceEnv,
            serviceDefinitionEnv: serviceEnv,
            serviceUpdateVerdict: {
              kind: "owned",
              root: "/synthetic/openclaw",
              fingerprint: "owned",
              refreshDefinition: false,
            },
          },
        });
        if (scenario === "other legacy source" || scenario === "other invalid source") {
          await expect(inspected).rejects.toMatchObject({ reason: "database-schema-preflight" });
        } else {
          const context = await inspected;
          expect(context?.config.gateway?.bind).toBe(
            scenario === "same source" ? "loopback" : "lan",
          );
          expect(context?.configSnapshot.path).toBe(servicePath);
          expect(context?.configSnapshot.valid).toBe(scenario !== "same source");
          if (scenario === "other valid source") {
            expect(context?.legacyConfigPlan).toBeUndefined();
          }
        }
        expect(fs.readFileSync(servicePath)).toEqual(before);
        expect(fs.existsSync(resolveOpenClawStateSqlitePath(serviceEnv))).toBe(false);
        expect({ ...process.env }).toEqual(originalEnv);
      });
    });
  });

  it("does not admit unrelated invalid settings alongside a migratable field", async () => {
    await withTempHome(async (home) => {
      await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local", bind: "localhost", port: "invalid" },
        });
        const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath };
        const before = fs.readFileSync(configPath);
        const { snapshot, writeOptions } = await createConfigIO({
          env,
          observe: false,
        }).readConfigFileSnapshotForWrite();
        const legacyConfigPlan = planLegacyConfigForUpdateChannel(snapshot, writeOptions);
        expect(legacyConfigPlan).toBeUndefined();
        await expect(
          captureTargetDatabaseSchemaContext(env, { legacyConfigPlan }),
        ).rejects.toMatchObject({ reason: "database-schema-preflight" });
        expect(fs.readFileSync(configPath)).toEqual(before);
      });
    });
  });
});
