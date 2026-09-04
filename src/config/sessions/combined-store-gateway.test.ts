import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { filterAndSortSessionEntries } from "../../gateway/session-utils-list.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadCombinedSessionStoreForGatewayCore } from "./combined-store-gateway.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";

it("projects shared rows under their logical owner while retaining the physical database owner", async () => {
  await withOpenClawTestState({ label: "combined-store-owner" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {}, worker: {} },
        defaults: { sessionStore: { agentId: "ops" } },
      },
      session: { scope: "global", store: storePath },
    };
    openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    for (const sessionKey of ["global", "unknown", "agent:worker:task"]) {
      replaceSessionEntrySync(
        { agentId: sessionKey.startsWith("agent:") ? "worker" : "ops", sessionKey, storePath },
        { sessionId: `session-${sessionKey}`, updatedAt: 1 },
      );
    }

    for (const configuredAgentsOnly of [false, true]) {
      const combined = loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly });
      expect(combined.durableTargets).toEqual([{ agentId: "main", storePath }]);
      expect(Object.fromEntries(combined.agentIdBySessionKey)).toEqual({
        global: "ops",
        unknown: "ops",
        "agent:worker:task": "worker",
      });
    }
    for (const [agentId, keys] of [
      ["main", []],
      ["ops", ["global", "unknown"]],
      ["worker", ["agent:worker:task"]],
    ] as const) {
      const combined = loadCombinedSessionStoreForGatewayCore(cfg, { agentId });
      expect(Object.keys(combined.store).toSorted()).toEqual([...keys].toSorted());
    }
  });
});

it("keeps fixed-store ownership out of separate registered and suffixed databases", async () => {
  await withOpenClawTestState({ label: "combined-store-partitions" }, async (state) => {
    const storePath = state.statePath("shared.json");
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {} },
        defaults: { sessionStore: { agentId: "ops" } },
      },
      session: { store: storePath },
    };
    for (const agentId of ["main", "ops"]) {
      replaceSessionEntrySync(
        { agentId, defaultAgentId: "main", sessionKey: "global", storePath },
        { sessionId: `global-${agentId}`, updatedAt: 1 },
      );
    }
    for (const agentId of ["main", "ops"]) {
      const combined = loadCombinedSessionStoreForGatewayCore(cfg, { agentId });
      expect(combined.store.global?.sessionId).toBe(`global-${agentId}`);
      expect(combined.agentIdBySessionKey.get("global")).toBe(agentId);
    }

    const registeredPath = state.statePath("separate.sqlite");
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "unknown", storePath: registeredPath },
      { sessionId: "separate-main", updatedAt: 1 },
    );
    const combined = loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly: true });
    expect(combined.store.unknown?.sessionId).toBe("separate-main");
    expect(combined.agentIdBySessionKey.get("unknown")).toBe("main");
  });
});

it.for([false, true])(
  "preserves qualified retired-owner keys in a shared store (alias=%s)",
  async (alias, context) => {
    if (alias && process.platform === "win32") {
      context.skip();
    }
    await withOpenClawTestState({ label: "combined-store-retired-owner" }, async (state) => {
      const storePath = state.statePath("shared.sqlite");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { ops: {}, worker: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
        session: { store: storePath },
      };
      const physicalPath = alias
        ? path.join(state.agentDir("main"), "openclaw-agent.sqlite")
        : storePath;
      openOpenClawAgentDatabase({ agentId: "main", path: physicalPath });
      if (alias) {
        await fs.symlink(physicalPath, storePath);
      }
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:main", storePath },
        { sessionId: "retired-main", updatedAt: 1 },
      );
      replaceSessionEntrySync(
        { agentId: "ops", sessionKey: "global", storePath },
        {
          sessionId: "ops-global",
          updatedAt: 1,
          parentSessionKey: "agent:main:main",
          spawnedBy: "agent:main:main",
        },
      );

      // Repeat the configured-only load to exercise the prepared target snapshot.
      for (const configuredAgentsOnly of [false, true, true]) {
        const combined = loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly });
        if (configuredAgentsOnly) {
          expect(combined.store["agent:main:main"]).toBeUndefined();
          expect(combined.agentIdBySessionKey.has("agent:main:main")).toBe(false);
        } else {
          expect(combined.store["agent:main:main"]?.sessionId).toBe("retired-main");
          expect(combined.agentIdBySessionKey.get("agent:main:main")).toBe("main");
        }
        expect(combined.agentIdBySessionKey.get("global")).toBe("ops");
        expect(combined.store.global).toMatchObject({
          parentSessionKey: "agent:main:main",
          spawnedBy: "agent:main:main",
        });
      }
      expect(loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "ops" }).store).toEqual({
        global: expect.objectContaining({ sessionId: "ops-global" }),
      });
    });
  },
);

it.for(["main", "unknown", "global"])(
  "resolves global lineage aliases without folding sentinels (mainKey=%s)",
  async (mainKey) => {
    await withOpenClawTestState({ label: "combined-store-global-lineage" }, async (state) => {
      const storePath = state.statePath("shared.sqlite");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {}, worker: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
        session: { scope: "global", mainKey, store: storePath },
      };
      const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      setCanonicalSqliteSessionMainKey(database, mainKey);
      for (const sessionKey of ["global", "unknown"]) {
        replaceSessionEntrySync(
          { agentId: "ops", sessionKey, storePath },
          { sessionId: `parent-${sessionKey}`, updatedAt: Date.now() },
        );
      }
      for (const [name, parentSessionKey, parentSessionId] of [
        ["alias", `agent:ops:${mainKey}`, "parent-global"],
        ["global", "global", "parent-global"],
        ["unknown", "unknown", "parent-unknown"],
      ] as const) {
        replaceSessionEntrySync(
          { agentId: "worker", sessionKey: `agent:worker:subagent:${name}`, storePath },
          {
            sessionId: `child-${name}`,
            updatedAt: Date.now(),
            status: "running",
            parentSessionId,
            parentSessionKey,
            spawnedBy: parentSessionKey,
          },
        );
      }
      const { store } = loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly: true });
      for (const [spawnedBy, children] of [
        ["global", ["alias", "global"]],
        ["unknown", ["unknown"]],
      ] as const) {
        const selected = filterAndSortSessionEntries({
          cfg,
          store,
          opts: { spawnedBy },
          now: Date.now(),
        });
        expect(selected.map(([key]) => key).toSorted()).toEqual(
          children.map((name) => `agent:worker:subagent:${name}`).toSorted(),
        );
      }
    });
  },
);

it("filters retired stores by canonical lineage owners without selecting an implicit agent", async () => {
  await withOpenClawTestState({ label: "combined-store-retired-lineage" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      session: { store: state.statePath("agents", "{agentId}", "sessions", "sessions.json") },
    };
    const storePath = state.statePath("agents", "archive", "sessions", "sessions.json");
    for (const [name, parentSessionKey] of [
      ["retired", "agent:main:main"],
      ["configured", "agent:ops:main"],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "archive", sessionKey: `agent:archive:${name}`, storePath },
        { sessionId: name, updatedAt: 1, parentSessionKey, spawnedBy: parentSessionKey },
      );
    }
    const unfiltered = loadCombinedSessionStoreForGatewayCore(cfg);
    expect(unfiltered.store["agent:archive:retired"]).toMatchObject({
      parentSessionKey: "agent:main:main",
      spawnedBy: "agent:main:main",
    });
    const filtered = loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly: true });
    expect(Object.keys(filtered.store)).toEqual(["agent:archive:configured"]);
    expect(Object.fromEntries(filtered.agentIdBySessionKey)).toEqual({
      "agent:archive:configured": "archive",
    });
    expect(filtered.store["agent:archive:configured"]).toMatchObject({
      parentSessionKey: "agent:ops:main",
      spawnedBy: "agent:ops:main",
    });
  });
});

it.skipIf(process.platform === "win32")(
  "keeps suffix owners when a legacy selector aliases the shared database",
  async () => {
    await withOpenClawTestState({ label: "combined-store-selector-alias" }, async (state) => {
      const storePath = state.statePath("shared.json");
      const sqlitePath = state.statePath("shared.sqlite");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {}, worker: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
        session: { store: storePath },
      };
      openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });
      await fs.symlink(sqlitePath, storePath);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "global", storePath },
        { sessionId: "main-global", updatedAt: 1 },
      );
      replaceSessionEntrySync(
        { agentId: "worker", defaultAgentId: "main", sessionKey: "unknown", storePath },
        { sessionId: "worker-unknown", updatedAt: 1 },
      );
      for (const configuredAgentsOnly of [false, true, true]) {
        const combined = loadCombinedSessionStoreForGatewayCore(cfg, { configuredAgentsOnly });
        expect(combined.store.unknown?.sessionId).toBe("worker-unknown");
        expect(combined.agentIdBySessionKey.get("unknown")).toBe("worker");
        expect(combined.store.global?.sessionId).toBe("main-global");
        expect(combined.agentIdBySessionKey.get("global")).toBe("main");
      }
      const scoped = loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "worker" });
      expect(scoped.agentIdBySessionKey.get("unknown")).toBe("worker");
      expect(loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "ops" }).store).toEqual({});
      expect(
        loadCombinedSessionStoreForGatewayCore(cfg, { agentId: "main" }).agentIdBySessionKey.get(
          "global",
        ),
      ).toBe("main");
    });
  },
);
