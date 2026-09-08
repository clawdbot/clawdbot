import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
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
import { checkTargetDatabaseSchemasForContexts } from "./schema-preflight.js";

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
