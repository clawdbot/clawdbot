import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  upsertAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "./session-meta.js";

describe("ACP session metadata SQLite store", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("persists ACP metadata in SQLite without writing sessions.json acp blocks", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sess-acp",
            updatedAt: 100,
          },
        }),
        "utf8",
      );

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
      expect(loadSessionStore(storePath)[sessionKey]?.acp).toBeUndefined();
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
      const storedEntry = loadSessionStore(storePath)[sessionKey];
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
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [storeSessionKey]: {
            sessionId: "sess-acp",
            updatedAt: 100,
          },
        }),
        "utf8",
      );

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
      expect(loadSessionStore(storePath)[storeSessionKey]?.acp).toBeUndefined();

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
    });
  });

  it("ignores SQLite ACP metadata rows for replaced session ids", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sess-new",
            updatedAt: 100,
          },
        }),
        "utf8",
      );

      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey,
        sessionId: "sess-old",
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
        sessionId: "sess-new",
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

  it("lists SQLite ACP rows while joining current session-store entries", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions", "codex.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:s1";
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sess-acp",
            updatedAt: 100,
            model: "gpt-5.5",
          },
        }),
        "utf8",
      );
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
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sess-acp",
            updatedAt: 100,
          },
        }),
        "utf8",
      );
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
