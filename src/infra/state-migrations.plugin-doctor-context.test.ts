import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";

describe("plugin doctor session identity evidence", () => {
  it("preserves two current keys sharing an identity instead of inventing a main owner", async () => {
    await withOpenClawTestState(
      { label: "plugin-doctor-shared-id", applyEnv: false },
      async ({ env }) => {
        for (const sessionKey of ["agent:main:main", "agent:main:other"]) {
          await replaceSessionEntry(
            { agentId: "main", env, sessionKey },
            { sessionId: "shared-id", updatedAt: 1 },
          );
        }
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          env,
          config: {},
        });

        await expect(
          context.readSessionIdentityEvidenceBatch?.([{ agentId: "main", sessionId: "shared-id" }]),
        ).resolves.toEqual([{ agentId: "main", sessionId: "shared-id", state: "unknown" }]);
      },
    );
  });

  it.each(["per-agent", "fixed"] as const)(
    "proves absence from an initialized empty %s session store",
    async (kind) => {
      await withOpenClawTestState(
        { label: `plugin-doctor-empty-${kind}`, applyEnv: false },
        async ({ env, root }) => {
          const fixedStorePath = path.join(root, "fixed.sqlite");
          const config: OpenClawConfig =
            kind === "fixed" ? { session: { store: fixedStorePath } } : {};
          openOpenClawAgentDatabase({
            agentId: "main",
            env,
            ...(kind === "fixed" ? { path: fixedStorePath } : {}),
          });
          const context = createPluginDoctorStateMigrationContext({
            pluginId: "codex",
            env,
            config,
          });

          await expect(
            context.readSessionIdentityEvidenceBatch?.([{ agentId: "main", sessionId: "gone" }]),
          ).resolves.toEqual([{ agentId: "main", sessionId: "gone", state: "absent" }]);
          expect(context.deletePluginStateEntriesIfUnchanged).toBeUndefined();
        },
      );
    },
  );

  it.each(["missing", "broken"] as const)(
    "keeps a %s session store unknown rather than proving absence",
    async (kind) => {
      await withOpenClawTestState(
        { label: `plugin-doctor-${kind}`, applyEnv: false },
        async ({ env }) => {
          if (kind === "broken") {
            openOpenClawAgentDatabase({ agentId: "main", env }).db.exec(
              "PRAGMA user_version = 999",
            );
          }
          const context = createPluginDoctorStateMigrationContext({
            pluginId: "codex",
            env,
            config: {},
          });

          await expect(
            context.readSessionIdentityEvidenceBatch?.([{ agentId: "main", sessionId: "gone" }]),
          ).resolves.toEqual([{ agentId: "main", sessionId: "gone", state: "unknown" }]);
        },
      );
    },
  );

  it.each(["malformed", "mismatched-identity"] as const)(
    "keeps %s fixed-store rows unknown instead of treating them as empty",
    async (corruption) => {
      await withOpenClawTestState(
        { label: `plugin-doctor-fixed-${corruption}`, applyEnv: false },
        async ({ env, root }) => {
          const storePath = path.join(root, "fixed.sqlite");
          const sessionKey = "agent:main:broken";
          await replaceSessionEntry(
            { agentId: "main", env, sessionKey, storePath },
            { sessionId: "broken-session", updatedAt: 1 },
          );
          const database = openOpenClawAgentDatabase({ agentId: "main", env, path: storePath }).db;
          if (corruption === "malformed") {
            database
              .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
              .run("{broken", sessionKey);
          } else {
            database
              .prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?")
              .run("wrong-session", sessionKey);
          }
          const context = createPluginDoctorStateMigrationContext({
            pluginId: "codex",
            env,
            config: { session: { store: storePath } },
          });

          const sessionId = corruption === "malformed" ? "broken-session" : "wrong-session";
          await expect(
            context.readSessionIdentityEvidenceBatch?.([{ agentId: "main", sessionId }]),
          ).resolves.toEqual([{ agentId: "main", sessionId, state: "unknown" }]);
        },
      );
    },
  );

  it("resolves the authoritative canonical session key using the Doctor-owned environment", async () => {
    await withOpenClawTestState(
      { label: "plugin-doctor-current", applyEnv: false },
      async ({ env, root }) => {
        const storePath = path.join(root, "fixed.sqlite");
        const sessionKey = "agent:main:renamed";
        await replaceSessionEntry(
          { agentId: "main", env, sessionKey, storePath },
          { sessionId: "live", updatedAt: 1 },
        );
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          env,
          config: { session: { store: storePath } },
        });

        const requests = [
          { agentId: "main", sessionId: "live" },
          { agentId: "main", sessionId: "gone" },
          { agentId: "main", sessionId: "live" },
        ];
        await expect(context.readSessionIdentityEvidenceBatch?.([])).resolves.toEqual([]);
        await expect(context.readSessionIdentityEvidenceBatch?.(requests)).resolves.toEqual([
          { agentId: "main", sessionId: "live", state: "current", sessionKey },
          { agentId: "main", sessionId: "gone", state: "absent" },
          { agentId: "main", sessionId: "live", state: "current", sessionKey },
        ]);

        // Discovery may be cached within a context; row evidence must be read anew.
        await replaceSessionEntry(
          { agentId: "main", env, sessionKey, storePath },
          { sessionId: "gone", updatedAt: 2 },
        );
        await expect(context.readSessionIdentityEvidenceBatch?.(requests)).resolves.toEqual([
          { agentId: "main", sessionId: "live", state: "absent" },
          { agentId: "main", sessionId: "gone", state: "current", sessionKey },
          { agentId: "main", sessionId: "live", state: "absent" },
        ]);
      },
    );
  });

  it("deduplicates configured SQLite and discovered JSON aliases by physical owner", async () => {
    await withOpenClawTestState(
      { label: "plugin-doctor-physical-alias", applyEnv: false },
      async ({ env, stateDir }) => {
        const agentRoot = path.join(stateDir, "agents", "main");
        const storePath = path.join(agentRoot, "agent", "openclaw-agent.sqlite");
        fs.mkdirSync(path.join(agentRoot, "sessions"), { recursive: true });
        const sessionKey = "agent:main:renamed";
        await replaceSessionEntry(
          { agentId: "main", env, sessionKey, storePath },
          { sessionId: "live", updatedAt: 1 },
        );
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          env,
          config: {
            session: {
              store: path.join(stateDir, "agents", "{agentId}", "agent", "openclaw-agent.sqlite"),
            },
          },
        });

        await expect(
          context.readSessionIdentityEvidenceBatch?.([{ agentId: "main", sessionId: "live" }]),
        ).resolves.toEqual([{ agentId: "main", sessionId: "live", state: "current", sessionKey }]);
      },
    );
  });

  it("rejects retained destructive repair callbacks after their owner expires", async () => {
    await withOpenClawTestState(
      { label: "plugin-doctor-expired-repair", applyEnv: false },
      async ({ env }) => {
        let active = true;
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          env,
          config: {},
          repairAuthority: {
            assertCurrent() {
              if (!active) {
                throw new Error("repair owner expired");
              }
            },
            assertOwnedInTransaction() {},
          },
        });
        const options = { namespace: "doctor-repair", maxEntries: 10 };
        const store = context.openPluginStateKeyedStore<{ sessionId: string }>(options);
        await store.register("binding:retained", { sessionId: "gone" });
        const observed = context.readPluginStateEntriesInKeyRange?.(options.namespace, {
          prefix: "binding:",
          limit: 10,
        });
        expect(observed).toHaveLength(1);

        active = false;

        expect(() =>
          context.deletePluginStateEntriesIfUnchanged?.(options.namespace, observed ?? []),
        ).toThrow("repair owner expired");
        expect(() =>
          context.readPluginStateEntriesInKeyRange?.(options.namespace, {
            prefix: "binding:",
            limit: 10,
          }),
        ).toThrow("repair owner expired");
        await expect(
          context.readSessionIdentityEvidenceBatch?.([{ agentId: "main", sessionId: "gone" }]),
        ).rejects.toThrow("repair owner expired");
        await expect(store.lookup("binding:retained")).resolves.toEqual({ sessionId: "gone" });
      },
    );
  });
});
