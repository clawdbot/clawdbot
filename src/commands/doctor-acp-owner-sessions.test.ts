import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAcpDatabaseSessionKey,
  selectAcpSessionRow,
} from "../acp/runtime/session-meta-keys.js";
import { claimAcpSessionMetaForOwnerMigration } from "../acp/runtime/session-meta-owner-migration.js";
import {
  readAcpSessionMetaForEntry,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  applySessionEntryLifecycleMutation,
  ensureTranscriptGenerationsForCanonicalRepair,
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { migrateLegacyAcpOwnerSessions } from "./doctor-acp-owner-sessions.js";
import { insertLegacySession } from "./doctor-session-canonical-keys.test-support.js";

const sessionAccessorTestHooks = vi.hoisted(() => ({
  applyLifecycleMutation: vi.fn(),
  applyLifecycleMutationDelegate: undefined as
    | typeof applySessionEntryLifecycleMutation
    | undefined,
  ensureTranscriptGenerations: vi.fn(),
  ensureTranscriptGenerationsDelegate: undefined as
    | typeof ensureTranscriptGenerationsForCanonicalRepair
    | undefined,
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  sessionAccessorTestHooks.applyLifecycleMutationDelegate =
    actual.applySessionEntryLifecycleMutation;
  sessionAccessorTestHooks.applyLifecycleMutation.mockImplementation((params) =>
    actual.applySessionEntryLifecycleMutation(params),
  );
  sessionAccessorTestHooks.ensureTranscriptGenerationsDelegate =
    actual.ensureTranscriptGenerationsForCanonicalRepair;
  sessionAccessorTestHooks.ensureTranscriptGenerations.mockImplementation((sources) =>
    actual.ensureTranscriptGenerationsForCanonicalRepair(sources),
  );
  return {
    ...actual,
    applySessionEntryLifecycleMutation: sessionAccessorTestHooks.applyLifecycleMutation,
    ensureTranscriptGenerationsForCanonicalRepair:
      sessionAccessorTestHooks.ensureTranscriptGenerations,
  };
});

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

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  sessionAccessorTestHooks.applyLifecycleMutation.mockReset();
  sessionAccessorTestHooks.applyLifecycleMutation.mockImplementation((params) =>
    sessionAccessorTestHooks.applyLifecycleMutationDelegate!(params),
  );
  sessionAccessorTestHooks.ensureTranscriptGenerations.mockReset();
  sessionAccessorTestHooks.ensureTranscriptGenerations.mockImplementation((sources) =>
    sessionAccessorTestHooks.ensureTranscriptGenerationsDelegate!(sources),
  );
});

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

  it("fails closed when a configured default owner is also an alias harness", async () => {
    await withStateDirEnv("openclaw-doctor-acp-default-owner-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      cfg.acp = { defaultAgent: "codex" };
      cfg.agents?.list?.push({ id: "codex" });
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

  it("fails closed when a configured non-ACP owner is no longer allowed", async () => {
    await withStateDirEnv("openclaw-doctor-acp-configured-owner-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      cfg.acp = { allowedAgents: ["reviewer"] };
      cfg.agents?.list?.push({ id: "codex" });
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

  it("rejects divergent source metadata after an interrupted claim", async () => {
    await withStateDirEnv("openclaw-doctor-acp-meta-divergence-", async ({ stateDir }) => {
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
      writeAcpSessionMetaForMigration({
        env,
        lifecycleRevision: entry.lifecycleRevision,
        meta: {
          agent: "codex",
          backend: "acpx",
          lastActivityAt: 20,
          mode: "persistent",
          runtimeSessionName: "newer-legacy-peer",
          state: "idle",
        },
        sessionKey: sourceKey,
      });

      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });

      expect(report).toMatchObject({ conflicts: 1, eligible: 1, migrated: 0 });
      expect(
        readAcpSessionMetaForEntry({
          agentId: "codex",
          cfg,
          entry,
          env,
          sessionKey: sourceKey,
        })?.runtimeSessionName,
      ).toBe("newer-legacy-peer");
      expect(
        readAcpSessionMetaForEntry({
          agentId: "reviewer",
          cfg,
          entry,
          env,
          sessionKey: targetKey,
        })?.runtimeSessionName,
      ).toBe("legacy-peer");
    });
  });

  it("rejects divergent canonical and legacy target metadata", async () => {
    await withStateDirEnv("openclaw-doctor-acp-target-meta-divergence-", async ({ stateDir }) => {
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
      writeAcpSessionMetaForMigration({
        env,
        lifecycleRevision: entry.lifecycleRevision,
        meta: {
          agent: "codex",
          backend: "acpx",
          lastActivityAt: 20,
          mode: "persistent",
          runtimeSessionName: "divergent-target-peer",
          state: "idle",
        },
        sessionKey: targetKey,
      });

      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });

      expect(report).toMatchObject({ conflicts: 1, eligible: 1, migrated: 0 });
      const rows = withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => ({
          canonical: selectAcpSessionRow(db, buildAcpDatabaseSessionKey(targetKey, "reviewer")),
          legacy: selectAcpSessionRow(db, targetKey),
        }),
        { env },
      );
      expect(rows?.canonical?.runtime_session_name).toBe("legacy-peer");
      expect(rows?.legacy?.runtime_session_name).toBe("divergent-target-peer");
    });
  });

  it("rejects divergent canonical and legacy source metadata", async () => {
    await withStateDirEnv("openclaw-doctor-acp-source-meta-divergence-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      seedLegacySession({ cfg, env });
      const canonicalSourceKey = buildAcpDatabaseSessionKey(sourceKey, "codex");
      writeAcpSessionMetaForMigration({
        env,
        lifecycleRevision: entry.lifecycleRevision,
        meta: {
          agent: "codex",
          backend: "acpx",
          lastActivityAt: 20,
          mode: "persistent",
          runtimeSessionName: "divergent-source-peer",
          state: "idle",
        },
        sessionKey: canonicalSourceKey,
      });

      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });

      expect(report).toMatchObject({ conflicts: 1, eligible: 1, migrated: 0 });
      const rows = withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => ({
          canonicalSource: selectAcpSessionRow(db, canonicalSourceKey),
          legacySource: selectAcpSessionRow(db, sourceKey),
          target: selectAcpSessionRow(db, buildAcpDatabaseSessionKey(targetKey, "reviewer")),
        }),
        { env },
      );
      expect(rows?.canonicalSource?.runtime_session_name).toBe("divergent-source-peer");
      expect(rows?.legacySource?.runtime_session_name).toBe("legacy-peer");
      expect(rows?.target).toBeUndefined();
    });
  });

  it("canonicalizes matching target metadata left under a legacy key", async () => {
    await withStateDirEnv("openclaw-doctor-acp-target-meta-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      seedLegacySession({ cfg, env });
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
        sessionKey: targetKey,
      });

      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });
      expect(report.warnings).toEqual([]);
      expect(report).toMatchObject({ conflicts: 0, eligible: 1, migrated: 1 });
      const rows = withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => ({
          canonical: selectAcpSessionRow(db, buildAcpDatabaseSessionKey(targetKey, "reviewer")),
          legacy: selectAcpSessionRow(db, targetKey),
        }),
        { env },
      );
      expect(rows?.canonical?.agent).toBe("codex");
      expect(rows?.legacy).toBeUndefined();
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

  it("keeps the legacy row when the canonical target appears during migration preparation", async () => {
    await withStateDirEnv("openclaw-doctor-acp-race-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      const sourceStorePath = seedLegacySession({ cfg, env });
      const targetStorePath = resolveSessionStorePathCore(cfg.session?.store, {
        agentId: "reviewer",
        env,
      });
      const concurrentEntry = { sessionId: "concurrent-session", updatedAt: 20 };
      sessionAccessorTestHooks.ensureTranscriptGenerations.mockImplementationOnce(
        async (sources) => {
          await sessionAccessorTestHooks.ensureTranscriptGenerationsDelegate!(sources);
          replaceSessionEntrySync(
            { agentId: "reviewer", env, sessionKey: targetKey, storePath: targetStorePath },
            concurrentEntry,
          );
        },
      );

      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });

      expect(report).toMatchObject({ conflicts: 1, eligible: 1, migrated: 0 });
      expect(report.warnings.join("\n")).toContain("changed during migration");
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "codex",
          env,
          sessionKey: sourceKey,
          storePath: sourceStorePath,
        })?.entry,
      ).toMatchObject(entry);
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "reviewer",
          env,
          sessionKey: targetKey,
          storePath: targetStorePath,
        })?.entry,
      ).toMatchObject(concurrentEntry);
    });
  });

  it("removes a staged canonical copy when the legacy source changes before removal", async () => {
    await withStateDirEnv("openclaw-doctor-acp-source-race-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      const sourceStorePath = seedLegacySession({ cfg, env });
      const targetStorePath = resolveSessionStorePathCore(cfg.session?.store, {
        agentId: "reviewer",
        env,
      });
      const concurrentEntry = { ...entry, model: "newer", updatedAt: 20 };
      let mutationCount = 0;
      sessionAccessorTestHooks.applyLifecycleMutation.mockImplementation(async (params) => {
        mutationCount += 1;
        if (mutationCount === 2) {
          replaceSessionEntrySync(
            { agentId: "codex", env, sessionKey: sourceKey, storePath: sourceStorePath },
            concurrentEntry,
          );
        }
        return await sessionAccessorTestHooks.applyLifecycleMutationDelegate!(params);
      });

      await expect(migrateLegacyAcpOwnerSessions({ apply: true, cfg, env })).resolves.toMatchObject(
        { conflicts: 1, eligible: 1, migrated: 0 },
      );
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "codex",
          env,
          sessionKey: sourceKey,
          storePath: sourceStorePath,
        })?.entry,
      ).toMatchObject(concurrentEntry);
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "reviewer",
          env,
          sessionKey: targetKey,
          storePath: targetStorePath,
        }),
      ).toBeUndefined();

      sessionAccessorTestHooks.applyLifecycleMutation.mockImplementation((params) =>
        sessionAccessorTestHooks.applyLifecycleMutationDelegate!(params),
      );
      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });
      expect(report.warnings).toEqual([]);
      expect(report).toMatchObject({ conflicts: 0, eligible: 1, migrated: 1 });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "reviewer",
          env,
          sessionKey: targetKey,
          storePath: targetStorePath,
        })?.entry,
      ).toMatchObject(concurrentEntry);
    });
  });

  it("preserves a canonical target completed by a concurrent migration", async () => {
    await withStateDirEnv("openclaw-doctor-acp-concurrent-finish-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      const sourceStorePath = seedLegacySession({ cfg, env });
      const targetStorePath = resolveSessionStorePathCore(cfg.session?.store, {
        agentId: "reviewer",
        env,
      });
      let removedConcurrently = false;
      sessionAccessorTestHooks.applyLifecycleMutation.mockImplementation(async (params) => {
        if (
          !removedConcurrently &&
          params.storePath === sourceStorePath &&
          params.removals?.some((removal) => removal.sessionKey === sourceKey)
        ) {
          removedConcurrently = true;
          await sessionAccessorTestHooks.applyLifecycleMutationDelegate!(params);
        }
        return await sessionAccessorTestHooks.applyLifecycleMutationDelegate!(params);
      });

      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });

      expect(report.warnings).toEqual([]);
      expect(report).toMatchObject({ conflicts: 0, eligible: 1, migrated: 1 });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "codex",
          env,
          sessionKey: sourceKey,
          storePath: sourceStorePath,
        }),
      ).toBeUndefined();
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "reviewer",
          env,
          sessionKey: targetKey,
          storePath: targetStorePath,
        })?.entry,
      ).toMatchObject(entry);
    });
  });

  it("keeps both rows when an interrupted staged target is stale on retry", async () => {
    await withStateDirEnv("openclaw-doctor-acp-interrupted-retry-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const cfg = createConfig(stateDir);
      const sourceStorePath = seedLegacySession({ cfg, env });
      const targetStorePath = resolveSessionStorePathCore(cfg.session?.store, {
        agentId: "reviewer",
        env,
      });
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
      replaceSessionEntrySync(
        { agentId: "reviewer", env, sessionKey: targetKey, storePath: targetStorePath },
        entry,
      );
      const concurrentEntry = { ...entry, model: "newer", updatedAt: 20 };
      replaceSessionEntrySync(
        { agentId: "codex", env, sessionKey: sourceKey, storePath: sourceStorePath },
        concurrentEntry,
      );

      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });

      expect(report).toMatchObject({ conflicts: 1, eligible: 0, migrated: 0 });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "codex",
          env,
          sessionKey: sourceKey,
          storePath: sourceStorePath,
        })?.entry,
      ).toMatchObject(concurrentEntry);
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "reviewer",
          env,
          sessionKey: targetKey,
          storePath: targetStorePath,
        })?.entry,
      ).toMatchObject(entry);
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

  it("atomically moves scoped keys inside a shared owner and harness store", async () => {
    await withStateDirEnv("openclaw-doctor-acp-shared-scoped-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const sharedStore = path.join(stateDir, "sessions.json");
      const cfg = createConfig(stateDir);
      cfg.session = { store: sharedStore };
      seedLegacySession({ cfg, env });

      const report = await migrateLegacyAcpOwnerSessions({ apply: true, cfg, env });
      expect(report.warnings).toEqual([]);
      expect(report).toMatchObject({ conflicts: 0, eligible: 1, migrated: 1 });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "codex",
          env,
          sessionKey: sourceKey,
          storePath: sharedStore,
        }),
      ).toBeUndefined();
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "reviewer",
          env,
          sessionKey: targetKey,
          storePath: sharedStore,
        })?.entry,
      ).toMatchObject(entry);
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
