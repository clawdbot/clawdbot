import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimAcpSessionMetaForOwnerMigration } from "../acp/runtime/session-meta-owner-migration.js";
import {
  readAcpSessionMetaForEntry,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { migrateLegacyAcpOwnerSessions } from "./doctor-acp-owner-sessions.js";
import { insertLegacySession } from "./doctor-session-canonical-keys.test-support.js";

const sourceKey = "agent:codex:acp:legacy";
const targetKey = "agent:reviewer:acp:legacy";
const entry = {
  lifecycleRevision: "revision-legacy",
  sessionId: "session-legacy",
  spawnedBy: "agent:main:main",
  updatedAt: 10,
} satisfies SessionEntry;

function createConfig(stateDir: string, owners = ["reviewer"]): OpenClawConfig {
  return {
    agents: {
      list: owners.map((id) => ({
        id,
        runtime: { type: "acp" as const, acp: { agent: "codex", backend: "acpx" } },
      })),
    },
    session: { store: path.join(stateDir, "agents", "{agentId}", "sessions.json") },
  };
}

function seedLegacySession(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  sessionKey?: string;
}): string {
  const sessionKey = params.sessionKey ?? sourceKey;
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: "codex",
    env: params.env,
  });
  replaceSessionEntrySync({ agentId: "codex", env: params.env, sessionKey, storePath }, entry);
  writeAcpSessionMetaForMigration({
    env: params.env,
    lifecycleRevision: entry.lifecycleRevision,
    meta: {
      agent: "codex",
      backend: "acpx",
      lastActivityAt: 10,
      mode: "persistent",
      runtimeSessionName: "legacy-peer",
      state: "idle",
    },
    sessionKey,
  });
  return storePath;
}

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("Doctor ACP owner migration", () => {
  it("moves one eligible harness-owned session exactly once", async () => {
    await withStateDirEnv("openclaw-doctor-acp-owner-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      const sourceStorePath = seedLegacySession({ cfg, env });
      const targetStorePath = resolveSessionStorePathCore(cfg.session?.store, {
        agentId: "reviewer",
        env,
      });

      await expect(
        migrateLegacyAcpOwnerSessions({ apply: false, cfg, env }),
      ).resolves.toMatchObject({
        eligible: 1,
        migrated: 0,
      });
      await expect(migrateLegacyAcpOwnerSessions({ apply: true, cfg, env })).resolves.toMatchObject(
        {
          eligible: 1,
          migrated: 1,
        },
      );
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "codex",
          env,
          sessionKey: sourceKey,
          storePath: sourceStorePath,
        }),
      ).toBeUndefined();
      const migratedEntry = loadExactSessionEntryReadOnly({
        agentId: "reviewer",
        env,
        sessionKey: targetKey,
        storePath: targetStorePath,
      })?.entry;
      expect(migratedEntry).toMatchObject({ sessionId: entry.sessionId });
      expect(
        readAcpSessionMetaForEntry({
          agentId: "reviewer",
          cfg,
          entry: migratedEntry,
          env,
          sessionKey: targetKey,
        })?.runtimeSessionName,
      ).toBe("legacy-peer");
      await expect(migrateLegacyAcpOwnerSessions({ apply: true, cfg, env })).resolves.toMatchObject(
        {
          eligible: 0,
          migrated: 0,
        },
      );
    });
  });

  it("fails closed when multiple configured owners share one harness", async () => {
    await withStateDirEnv("openclaw-doctor-acp-ambiguous-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir, ["reviewer", "writer"]);
      const sourceStorePath = seedLegacySession({ cfg, env });

      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });
      expect(report).toMatchObject({ ambiguous: 1, eligible: 0, migrated: 0 });
      expect(report.warnings.join("\n")).toContain("multiple owners (reviewer, writer)");
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "codex",
          env,
          sessionKey: sourceKey,
          storePath: sourceStorePath,
        }),
      ).toBeDefined();
    });
  });

  it("fails closed when a harness is both a configured owner and another alias target", async () => {
    await withStateDirEnv("openclaw-doctor-acp-self-owner-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir, ["codex", "reviewer"]);
      const sourceStorePath = seedLegacySession({ cfg, env });

      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });
      expect(report).toMatchObject({ ambiguous: 1, eligible: 0, migrated: 0 });
      expect(report.warnings.join("\n")).toContain("multiple owners (codex, reviewer)");
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "codex",
          env,
          sessionKey: sourceKey,
          storePath: sourceStorePath,
        }),
      ).toBeDefined();
    });
  });

  it("cannot replay a consumed legacy peer through a later alias", async () => {
    await withStateDirEnv("openclaw-doctor-acp-consumed-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      seedLegacySession({ cfg, env });
      await expect(migrateLegacyAcpOwnerSessions({ apply: true, cfg, env })).resolves.toMatchObject(
        {
          migrated: 1,
        },
      );

      const reassigned = createConfig(stateDir, ["writer"]);
      await expect(
        migrateLegacyAcpOwnerSessions({ apply: true, cfg: reassigned, env }),
      ).resolves.toMatchObject({ eligible: 0, migrated: 0 });
      const writerStorePath = resolveSessionStorePathCore(reassigned.session?.store, {
        agentId: "writer",
        env,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "writer",
          env,
          sessionKey: "agent:writer:acp:legacy",
          storePath: writerStorePath,
        }),
      ).toBeUndefined();
    });
  });

  it("finishes a retry after metadata was claimed before the session row moved", async () => {
    await withStateDirEnv("openclaw-doctor-acp-retry-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      seedLegacySession({ cfg, env });
      expect(
        claimAcpSessionMetaForOwnerMigration({
          cfg,
          entry,
          env,
          expectedAgent: "codex",
          sourceAgentId: "codex",
          sourceSessionKey: sourceKey,
          targetAgentId: "reviewer",
          targetSessionKey: targetKey,
        }),
      ).toBe("claimed");

      await expect(migrateLegacyAcpOwnerSessions({ apply: true, cfg, env })).resolves.toMatchObject(
        {
          eligible: 1,
          migrated: 1,
        },
      );
      await expect(migrateLegacyAcpOwnerSessions({ apply: true, cfg, env })).resolves.toMatchObject(
        {
          eligible: 0,
          migrated: 0,
        },
      );
    });
  });

  it("fails closed when the canonical owner key contains another session", async () => {
    await withStateDirEnv("openclaw-doctor-acp-conflict-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      const sourceStorePath = seedLegacySession({ cfg, env });
      const targetStorePath = resolveSessionStorePathCore(cfg.session?.store, {
        agentId: "reviewer",
        env,
      });
      replaceSessionEntrySync(
        { agentId: "reviewer", env, sessionKey: targetKey, storePath: targetStorePath },
        { sessionId: "different-session", updatedAt: 20 },
      );

      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });
      expect(report).toMatchObject({ conflicts: 1, eligible: 0, migrated: 0 });
      expect(report.warnings.join("\n")).toContain("different identity");
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "codex",
          env,
          sessionKey: sourceKey,
          storePath: sourceStorePath,
        }),
      ).toBeDefined();
    });
  });

  it("leaves a bare key in a shared owner and harness store ambiguous", async () => {
    await withStateDirEnv("openclaw-doctor-acp-shared-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const sharedStore = path.join(stateDir, "sessions.json");
      const cfg = createConfig(stateDir);
      cfg.session = { store: sharedStore };
      insertLegacySession({
        agentId: "codex",
        entry,
        env,
        sessionKey: "shared-project",
        storePath: sharedStore,
      });
      writeAcpSessionMetaForMigration({
        env,
        lifecycleRevision: entry.lifecycleRevision,
        meta: {
          agent: "codex",
          backend: "acpx",
          lastActivityAt: 10,
          mode: "persistent",
          runtimeSessionName: "legacy-peer",
          state: "idle",
        },
        sessionKey: "shared-project",
      });

      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });
      expect(report).toMatchObject({ ambiguous: 1, eligible: 0, migrated: 0 });
      expect(report.warnings.join("\n")).toContain("owner is ambiguous");
    });
  });

  it("moves a bare key from a separate harness store", async () => {
    await withStateDirEnv("openclaw-doctor-acp-bare-separate-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      const sourceStorePath = resolveSessionStorePathCore(cfg.session?.store, {
        agentId: "codex",
        env,
      });
      insertLegacySession({
        agentId: "codex",
        entry,
        env,
        sessionKey: "shared-project",
        storePath: sourceStorePath,
      });
      writeAcpSessionMetaForMigration({
        env,
        lifecycleRevision: entry.lifecycleRevision,
        meta: {
          agent: "codex",
          backend: "acpx",
          lastActivityAt: 10,
          mode: "persistent",
          runtimeSessionName: "legacy-peer",
          state: "idle",
        },
        sessionKey: "shared-project",
      });
      const targetStorePath = resolveSessionStorePathCore(cfg.session?.store, {
        agentId: "reviewer",
        env,
      });

      await expect(migrateLegacyAcpOwnerSessions({ apply: true, cfg, env })).resolves.toMatchObject(
        { ambiguous: 0, eligible: 1, migrated: 1 },
      );
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "codex",
          env,
          sessionKey: "shared-project",
          storePath: sourceStorePath,
        }),
      ).toBeUndefined();
      const migratedEntry = loadExactSessionEntryReadOnly({
        agentId: "reviewer",
        env,
        sessionKey: "agent:reviewer:shared-project",
        storePath: targetStorePath,
      })?.entry;
      expect(migratedEntry).toMatchObject({ sessionId: entry.sessionId });
      expect(
        readAcpSessionMetaForEntry({
          agentId: "reviewer",
          cfg,
          entry: migratedEntry,
          env,
          sessionKey: "agent:reviewer:shared-project",
        })?.runtimeSessionName,
      ).toBe("legacy-peer");
    });
  });

  it("does not report unrelated bare sessions as ACP migration ambiguity", async () => {
    await withStateDirEnv("openclaw-doctor-acp-unrelated-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const sharedStore = path.join(stateDir, "sessions.json");
      const cfg = createConfig(stateDir);
      cfg.session = { store: sharedStore };
      insertLegacySession({
        agentId: "codex",
        entry,
        env,
        sessionKey: "ordinary-chat",
        storePath: sharedStore,
      });

      await expect(
        migrateLegacyAcpOwnerSessions({ apply: false, cfg, env }),
      ).resolves.toMatchObject({
        ambiguous: 0,
        eligible: 0,
        migrated: 0,
        warnings: [],
      });
    });
  });
});
