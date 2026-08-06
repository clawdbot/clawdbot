/** Tests ACP session metadata persistence, joins, and migration helpers. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  readAcpSessionMetaForEntry,
  repairAcpSessionMetaKeyForMigration,
  upsertAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "./session-meta.js";

const ACP_AGENT_ID = "codex";

async function seedAcpSessionEntry(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}): Promise<void> {
  await replaceSessionEntry(
    {
      agentId: ACP_AGENT_ID,
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    params.entry,
  );
}

function readStoredAcpSessionEntry(params: {
  storePath: string;
  sessionKey: string;
}): SessionEntry | undefined {
  return loadSessionEntry({
    agentId: ACP_AGENT_ID,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
  });
}

describe("ACP session metadata SQLite store", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("persists ACP metadata in SQLite without writing sessions.json acp blocks", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: {
          sessionId: "sess-acp",
          updatedAt: 100,
        },
      });

      const result = await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        now: () => 200,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-discord",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
          cwd: "/repo",
        }),
      });

      expect(result?.acp?.runtimeSessionName).toBe("codex-discord");
      expect(fs.existsSync(storePath)).toBe(false);
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey,
        })?.acp,
      ).toMatchObject({
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "codex-discord",
        mode: "persistent",
        state: "idle",
        cwd: "/repo",
      });
    });
  });

  it("clears legacy embedded ACP metadata through the session accessor", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: {
          sessionId: "sess-acp",
          updatedAt: 100,
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "legacy-embedded",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 120,
          },
        },
      });

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        now: () => 200,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-sqlite",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        }),
      });

      expect(readStoredAcpSessionEntry({ storePath, sessionKey })?.acp).toBeUndefined();
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-sqlite");
    });
  });

  it("creates a session-store row for new SQLite ACP sessions without embedding ACP metadata", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:new-session";

      const result = await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        now: () => 200,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-new",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        }),
      });

      expect(result?.sessionId).toEqual(expect.any(String));
      expect(result?.acp?.runtimeSessionName).toBe("codex-new");
      const storedEntry = readStoredAcpSessionEntry({ storePath, sessionKey });
      expect(storedEntry?.sessionId).toEqual(expect.any(String));
      expect(storedEntry?.updatedAt).toEqual(expect.any(Number));
      expect(storedEntry?.acp).toBeUndefined();
    });
  });

  it("normalizes ACP metadata lookups and writes to the resolved session-store key", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const storeSessionKey = "agent:codex:acp:binding:discord:default:feedface";
      const rawSessionKey = storeSessionKey.toUpperCase();
      await seedAcpSessionEntry({
        storePath,
        sessionKey: storeSessionKey,
        entry: {
          sessionId: "sess-acp",
          updatedAt: 100,
        },
      });

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: rawSessionKey,
        now: () => 200,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-normalized",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        }),
      });

      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: rawSessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-normalized");
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: storeSessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-normalized");
      expect(fs.existsSync(storePath)).toBe(false);
      const legacyEmbeddedEntry = readStoredAcpSessionEntry({
        storePath,
        sessionKey: storeSessionKey,
      });
      expect(legacyEmbeddedEntry).toBeDefined();
      if (!legacyEmbeddedEntry) {
        throw new Error("expected normalized ACP session entry");
      }
      await seedAcpSessionEntry({
        storePath,
        sessionKey: storeSessionKey,
        entry: {
          ...legacyEmbeddedEntry,
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "legacy-embedded",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 120,
          },
        },
      });

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: rawSessionKey,
        mutate: (current) => {
          expect(current?.runtimeSessionName).toBe("codex-normalized");
          return null;
        },
      });

      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: storeSessionKey,
        })?.acp,
      ).toBeUndefined();
      expect(
        readStoredAcpSessionEntry({ storePath, sessionKey: storeSessionKey })?.acp,
      ).toBeUndefined();
    });
  });

  it("keeps SQLite ACP metadata visible when legacy store keys are canonicalized", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const legacyStoreSessionKey = "agent:CODEX:acp:legacy-runtime";
      const canonicalSessionKey = "agent:codex:acp:legacy-runtime";
      await seedAcpSessionEntry({
        storePath,
        sessionKey: legacyStoreSessionKey,
        entry: {
          sessionId: "sess-acp",
          updatedAt: 100,
        },
      });

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: canonicalSessionKey,
        now: () => 200,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-canonicalized",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        }),
      });

      expect(
        readStoredAcpSessionEntry({ storePath, sessionKey: canonicalSessionKey })?.sessionId,
      ).toBe("sess-acp");
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: canonicalSessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-canonicalized");
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
    });
  });

  it("binds ACP metadata to the final accessor-selected entry for alias writes", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const canonicalSessionKey = "agent:codex:acp:alias-runtime";
      const legacyStoreSessionKey = "agent:CODEX:acp:alias-runtime";
      await seedAcpSessionEntry({
        storePath,
        sessionKey: canonicalSessionKey,
        entry: {
          sessionId: "sess-canonical",
          updatedAt: 100,
        },
      });
      await seedAcpSessionEntry({
        storePath,
        sessionKey: legacyStoreSessionKey,
        entry: {
          sessionId: "sess-legacy",
          updatedAt: 150,
        },
      });

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: legacyStoreSessionKey,
        now: () => 200,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-alias",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        }),
      });

      expect(
        readStoredAcpSessionEntry({ storePath, sessionKey: canonicalSessionKey })?.sessionId,
      ).toBe("sess-legacy");
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: canonicalSessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-alias");
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
    });
  });

  it("ignores SQLite ACP metadata rows from an older lifecycle revision", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: {
          sessionId: "sess-new",
          lifecycleRevision: "revision-new",
          updatedAt: 100,
        },
      });

      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey,
        lifecycleRevision: "revision-old",
        meta: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-stale",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        },
      });

      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey })?.acp).toBeUndefined();
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(0);

      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey,
        lifecycleRevision: "revision-new",
        meta: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-current",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 124,
        },
      });

      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey })?.acp?.runtimeSessionName).toBe(
        "codex-current",
      );
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
    });
  });

  it("reads ACP metadata rows written with the legacy session-id binding", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:binding:discord:default:legacy";
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: {
          sessionId: "sess-existing",
          lifecycleRevision: "revision-existing",
          sessionStartedAt: 50,
          updatedAt: 100,
        },
      });
      // Simulate the pre-boundary layout, where session_id stored the logical id.
      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey,
        lifecycleRevision: "sess-existing",
        now: () => 100,
        meta: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-legacy",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        },
      });

      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey })?.acp?.runtimeSessionName).toBe(
        "codex-legacy",
      );
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
      expect(
        readAcpSessionMetaForEntry({
          databasePath,
          sessionKey,
          entry: {
            sessionId: "sess-existing",
            lifecycleRevision: "revision-next",
            sessionStartedAt: 150,
          },
        }),
      ).toBeUndefined();

      const staleKey = `${sessionKey}:stale`;
      await seedAcpSessionEntry({
        storePath,
        sessionKey: staleKey,
        entry: {
          sessionId: "sess-stale",
          lifecycleRevision: "revision-after-reset",
          sessionStartedAt: 150,
          updatedAt: 150,
        },
      });
      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey: staleKey,
        lifecycleRevision: "sess-stale",
        now: () => 100,
        meta: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-stale-legacy",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
        },
      });
      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey: staleKey })?.acp).toBeUndefined();
    });
  });

  it("keeps a session-id fence when ACP metadata is written before a lifecycle revision", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const sessionKey = "agent:codex:acp:pre-revision";
      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey,
        sessionId: "sess-pre-revision",
        now: () => 100,
        meta: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-pre-revision",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
        },
      });

      expect(
        readAcpSessionMetaForEntry({
          databasePath,
          sessionKey,
          entry: {
            sessionId: "sess-pre-revision",
            lifecycleRevision: undefined,
            sessionStartedAt: 50,
          },
        })?.runtimeSessionName,
      ).toBe("codex-pre-revision");
      expect(
        readAcpSessionMetaForEntry({
          databasePath,
          sessionKey,
          entry: {
            sessionId: "sess-pre-revision",
            lifecycleRevision: "revision-after-reset",
            sessionStartedAt: 150,
          },
        }),
      ).toBeUndefined();
    });
  });

  it("repairs ACP metadata rows when session-store keys are canonicalized", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const legacyKey = "agent:CODEX:acp:legacy-runtime";
      const canonicalKey = "agent:codex:acp:legacy-runtime";
      await seedAcpSessionEntry({
        storePath,
        sessionKey: canonicalKey,
        entry: {
          sessionId: "sess-acp",
          lifecycleRevision: "revision-acp",
          updatedAt: 100,
        },
      });
      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey: legacyKey,
        lifecycleRevision: "revision-acp",
        meta: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: legacyKey,
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        },
      });

      expect(
        repairAcpSessionMetaKeyForMigration({
          databasePath,
          sessionKey: canonicalKey,
          entry: { lifecycleRevision: "revision-acp" },
          now: () => 200,
        }),
      ).toBe(true);

      expect(
        readAcpSessionMetaForEntry({
          databasePath,
          sessionKey: legacyKey,
          entry: { lifecycleRevision: "revision-acp" },
        }),
      ).toBeUndefined();
      expect(
        readAcpSessionEntry({ cfg, databasePath, sessionKey: canonicalKey })?.acp
          ?.runtimeSessionName,
      ).toBe(legacyKey);
    });
  });

  it("lists SQLite ACP rows while joining current session-store entries", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:s1";
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: {
          sessionId: "sess-acp",
          updatedAt: 100,
          model: "gpt-5.5",
        },
      });
      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-s1",
          mode: "oneshot",
          state: "running",
          lastActivityAt: 321,
        }),
      });

      const entries = await listAcpSessionEntries({ cfg, databasePath, clone: false });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        cfg,
        storePath,
        sessionKey,
        storeSessionKey: sessionKey,
        entry: {
          sessionId: "sess-acp",
          model: "gpt-5.5",
        },
        acp: {
          backend: "acpx",
          runtimeSessionName: "codex-s1",
          mode: "oneshot",
          state: "running",
        },
      });
    });
  });

  it("honors OPENCLAW_STATE_DIR when joining listed SQLite rows to session stores", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir } as NodeJS.ProcessEnv;
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:codex:acp:s1";
      const storePath = path.join(dir, "agents", "codex", "sessions", "sessions.json");
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: {
          sessionId: "sess-acp",
          updatedAt: 100,
        },
      });
      await upsertAcpSessionMeta({
        cfg,
        env,
        sessionKey,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-s1",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 321,
        }),
      });

      const entries = await listAcpSessionEntries({ cfg, env });

      expect(entries).toHaveLength(1);
      expect(entries[0]?.storePath).toBe(storePath);
      expect(entries[0]?.entry?.sessionId).toBe("sess-acp");
    });
  });
});
