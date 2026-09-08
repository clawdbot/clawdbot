import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgent } from "../agents/agent-create.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withTempHomeConfig, writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadExecApprovals, saveExecApprovals } from "../infra/exec-approvals.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import { readAgentProvenance } from "../state/agent-provenance.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabases,
  closeOpenClawAgentDatabaseByPath,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { agentDatabaseHeldRuntimeEntrypoint } from "../state/openclaw-state-lease-runtime.test-support.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { applyClawAddPlan } from "./add.js";
import {
  withClawAgentConfigRemoval,
  digestClawAgentConfig,
  digestClawAgentRemovalSurface,
} from "./lifecycle-config-removal.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { installClawMcpServers, readClawMcpServerRefs } from "./mcp.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabases();
  closeOpenClawStateDatabaseForTest();
  envSnapshot.restore();
});

const sourceMcpServer = { command: "fixture-mcp" };

async function buildApprovalFixture(withMcp = false) {
  const root = tempDirs.make("openclaw-claw-remove-approvals-");
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
    ...(withMcp ? { mcpServers: { docs: sourceMcpServer } } : {}),
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 100,
  };
  return await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, "workspace-worker") },
  });
}

function startHeldDatabase(agentId = "worker", pathname = "") {
  const childUrl = resolveRuntimeWorkerUrl(agentDatabaseHeldRuntimeEntrypoint);
  const child = spawn(
    process.execPath,
    [...resolveRuntimeWorkerArgv(childUrl), agentId, pathname],
    {
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let childError = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    childError = (childError + chunk.toString()).slice(-8192);
  });
  const closed = once(child, "close");
  return {
    ready: Promise.race([
      once(child, "message"),
      closed.then(() => {
        throw new Error(`Database opener exited: ${childError}`);
      }),
    ]),
    close: async () => {
      child.send("close");
      expect(await closed).toEqual([0, null]);
    },
    dispose: async () => {
      await stopChildProcess(child, 5000);
      await closed;
    },
  };
}

describe("Claw exec approvals removal", () => {
  it.each([false, true])("purges a retained session database (cold: %s)", async (cold) => {
    const addPlan = await buildApprovalFixture();
    await withTempHomeConfig({}, async ({ home }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", join(home, ".openclaw"));
      let config: OpenClawConfig = {};
      await applyClawAddPlan(addPlan, {
        consentPlanIntegrity: addPlan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      });
      const target = openOpenClawAgentDatabase({ agentId: "worker" });
      config = {
        ...config,
        agents: {
          ...config.agents,
          entries: { ...config.agents?.entries, kept: { workspace: dirname(target.path) } },
        },
      };
      await writeOpenClawConfig(home, config);
      const workerScope = { agentId: "worker", sessionKey: "agent:worker:main" };
      const keptScope = { agentId: "kept", sessionKey: "agent:kept:main" };
      replaceSessionEntrySync(workerScope, { sessionId: "worker-session", updatedAt: 1 });
      replaceSessionEntrySync(keptScope, { sessionId: "kept-session", updatedAt: 1 });
      if (cold) {
        closeOpenClawAgentDatabaseByPath(target.path);
      }
      const plan = await buildClawRemovePlan("worker");
      const trashPath = vi.fn(async () => true);
      await expect(
        applyClawRemovePlan(plan, {
          monitorGateway: quiescentClawMonitorGateway,
          consentPlanIntegrity: plan.planIntegrity,
          trashPath,
        }),
      ).resolves.toMatchObject({ status: "complete", agentRemoved: true });
      expect(loadSessionEntryReadOnly(workerScope)).toBeUndefined();
      expect(loadSessionEntryReadOnly(keptScope)?.sessionId).toBe("kept-session");
      expect(target.db.isOpen).toBe(false);
      expect(trashPath).not.toHaveBeenCalledWith(dirname(target.path), expect.anything());
      expect(readAgentDeletionJournal("worker")?.cleanupCompleted).toBe(true);
    });
  });

  it("retains an archive publication failure and completes its real session cleanup on retry", async () => {
    const addPlan = await buildApprovalFixture();
    await withTempHomeConfig({}, async ({ home }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", join(home, ".openclaw"));
      let config: OpenClawConfig = {};
      await applyClawAddPlan(addPlan, {
        consentPlanIntegrity: addPlan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      });
      const target = openOpenClawAgentDatabase({ agentId: "worker" });
      config = {
        ...config,
        agents: {
          ...config.agents,
          entries: { ...config.agents?.entries, kept: { workspace: dirname(target.path) } },
        },
      };
      await writeOpenClawConfig(home, config);
      const scope = {
        agentId: "worker",
        sessionKey: "agent:worker:main",
        sessionId: "worker-session",
      };
      replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await appendTranscriptMessage(scope, {
        message: { role: "user", content: "retained archive fixture" },
      });
      const sessionsDir = join(dirname(dirname(target.path)), "sessions");
      let obstructed = false;
      const unsubscribe = onSessionIdentityMutation((mutation) => {
        if (mutation.kind === "delete" && mutation.previous.sessionId === scope.sessionId) {
          // Obstruct file publication only after the real archive row and deletion commit.
          rmSync(sessionsDir, { force: true, recursive: true });
          writeFileSync(sessionsDir, "archive directory obstruction");
          obstructed = true;
        }
      });
      const plan = await buildClawRemovePlan("worker");
      const trashPath = vi.fn(async () => true);
      try {
        await expect(
          applyClawRemovePlan(plan, {
            monitorGateway: quiescentClawMonitorGateway,
            trashPath,
            consentPlanIntegrity: plan.planIntegrity,
          }),
        ).resolves.toMatchObject({ status: "partial", error: { code: "session_cleanup_failed" } });
      } finally {
        unsubscribe();
      }
      expect(obstructed).toBe(true);
      expect(trashPath).not.toHaveBeenCalled();
      expect(readAgentDeletionJournal("worker")?.cleanupCompleted).toBe(false);
      expect(readAgentProvenance("worker")).toBeDefined();
      const readArchives = () =>
        withOpenClawAgentDatabaseReadOnly(
          (database) =>
            database.db.prepare("SELECT published_at FROM session_transcript_archives").all(),
          { agentId: "worker" },
        );
      expect(readArchives()).toMatchObject({ found: true, value: [{ published_at: null }] });
      expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
      await rm(sessionsDir);
      const retry = await buildClawRemovePlan("worker");
      await expect(
        applyClawRemovePlan(retry, {
          monitorGateway: quiescentClawMonitorGateway,
          trashPath,
          consentPlanIntegrity: retry.planIntegrity,
        }),
      ).resolves.toMatchObject({ status: "complete" });
      expect(readAgentDeletionJournal("worker")?.cleanupCompleted).toBe(true);
      expect(readAgentProvenance("worker")).toBeUndefined();
      expect(readArchives()).toMatchObject({
        found: true,
        value: [{ published_at: expect.any(Number) }],
      });
    });
  });

  it("preserves config, approvals, and files until another process closes its database", async () => {
    const addPlan = await buildApprovalFixture(true);
    await withTempHomeConfig({}, async ({ home }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", join(home, ".openclaw"));
      let config: OpenClawConfig = {};
      await applyClawAddPlan(addPlan, {
        consentPlanIntegrity: addPlan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config);
        },
        installMcpServers: async () => [],
      });
      await installClawMcpServers(addPlan, {
        setMcpServer: async () => ({
          ok: true,
          path: "fixture",
          config: {},
          mcpServers: { docs: sourceMcpServer },
        }),
        listMcpServers: async () => ({ ok: true, path: "fixture", config: {}, mcpServers: {} }),
      });
      config = { ...config, mcp: { servers: { docs: sourceMcpServer } } };
      await writeOpenClawConfig(home, config);
      saveExecApprovals({ version: 1, agents: { worker: { security: "deny" } } });
      const configBefore = structuredClone(config);
      const approvalsBefore = loadExecApprovals();
      const provenanceBefore = readAgentProvenance("worker");
      expect(provenanceBefore?.createdVia).toBe("claw");
      const child = startHeldDatabase();
      try {
        await child.ready;
        const plan = await buildClawRemovePlan("worker", { config });
        const trashPath = vi.fn(async () => true);
        const unsetMcpServer = vi.fn(async () => ({
          ok: true as const,
          path: "fixture",
          config: {},
          mcpServers: {},
          removed: true,
        }));
        const removeOptions = {
          config,
          unsetMcpServer,
          trashPath,
        };
        await expect(
          applyClawRemovePlan(plan, {
            monitorGateway: quiescentClawMonitorGateway,
            ...removeOptions,
            consentPlanIntegrity: plan.planIntegrity,
          }),
        ).resolves.toMatchObject({
          status: "partial",
          agentRemoved: false,
          error: { message: expect.stringContaining("database is still open in another process") },
        });
        expect(
          JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8")),
        ).toEqual(configBefore);
        expect(loadExecApprovals()).toEqual(approvalsBefore);
        expect(readAgentProvenance("worker")).toEqual(provenanceBefore);
        expect(trashPath).not.toHaveBeenCalled();
        expect(unsetMcpServer).not.toHaveBeenCalled();
        expect(readClawMcpServerRefs("worker")).toHaveLength(1);
        expect(readAgentDeletionJournal("worker")).toMatchObject({ cleanupCompleted: false });
        const agentDir = join(home, ".openclaw", "agents", "worker", "agent");
        await withAgentDeletion("worker", async (begin) => {
          const deletion = begin({
            agentId: "worker",
            agentDir,
            workspaceDir: join(home, "workspace-worker"),
            sessionsDir: join(home, ".openclaw", "agents", "worker", "sessions"),
          });
          const cleanup = vi.fn(async () => undefined);
          try {
            await expect(
              deletion.runDatabaseCleanup(
                {
                  agentId: "worker",
                  path: join(agentDir, "openclaw-agent.sqlite"),
                },
                cleanup,
              ),
            ).rejects.toThrow("database is still open in another process");
            expect(cleanup).not.toHaveBeenCalled();
          } finally {
            deletion.rollback();
          }
        });
        await child.close();
        const retry = await buildClawRemovePlan("worker", { config });
        await expect(
          applyClawRemovePlan(retry, {
            monitorGateway: quiescentClawMonitorGateway,
            ...removeOptions,
            consentPlanIntegrity: retry.planIntegrity,
          }),
        ).resolves.toMatchObject({ status: "complete", agentRemoved: true });
        expect(trashPath).toHaveBeenCalled();
        expect(unsetMcpServer).toHaveBeenCalledOnce();
        expect(readAgentProvenance("worker")).toBeUndefined();
      } finally {
        await child.dispose();
      }
    });
  });

  it("refuses a cleanup capability while a foreign process holds a database beneath its paths", async () => {
    await withTempHomeConfig({}, async ({ home }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", join(home, ".openclaw"));
      const agentDir = join(home, ".openclaw", "agents", "worker", "agent");
      const target = { agentId: "kept", path: join(agentDir, "shared.sqlite") };
      const child = startHeldDatabase(target.agentId, target.path);
      try {
        await child.ready;
        await withAgentDeletion("worker", async (begin) => {
          const deletion = begin({
            agentId: "worker",
            agentDir,
            workspaceDir: join(home, "workspace-worker"),
            sessionsDir: join(home, ".openclaw", "agents", "worker", "sessions"),
          });
          const cleanup = vi.fn(async () => openOpenClawAgentDatabase(target));
          await expect(deletion.runDatabaseCleanup(target, cleanup)).rejects.toThrow(
            "agent worker deletion owns",
          );
          expect(cleanup).not.toHaveBeenCalled();
          await child.close();
          const database = await deletion.runDatabaseCleanup(target, cleanup);
          expect(database.db.isOpen).toBe(false);
          deletion.rollback();
        });
      } finally {
        await child.dispose();
      }
    });
  });

  it.each([
    { failClose: false, shared: false },
    { failClose: true, shared: false },
    { failClose: false, shared: true },
  ])(
    "closes configured and relocated databases in their state owner (failed close: $failClose, shared: $shared)",
    async ({ failClose, shared }) => {
      const root = tempDirs.make("claw-delete-lease-owner-");
      const env = { OPENCLAW_STATE_DIR: join(root, "state") };
      const agentDir = join(root, "custom-agent");
      const foreign = openOpenClawAgentDatabase({ agentId: "kept", env });
      const owned = openOpenClawAgentDatabase({
        agentId: "worker",
        env,
        path: join(agentDir, "openclaw-agent.sqlite"),
      });
      const relocated = openOpenClawAgentDatabase({
        agentId: "worker",
        env,
        path: join(root, "relocated.sqlite"),
      });
      const config: OpenClawConfig = {
        agents: {
          defaults: { authInheritance: { agentId: "main" } },
          entries: {
            worker: { agentDir, workspace: join(root, "workspace") },
            ...(shared ? { kept: { workspace: root } } : {}),
          },
        },
      };
      const originalConfig = structuredClone(config);
      const configPath = join(root, "openclaw.json");
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      await writeFile(configPath, JSON.stringify(config));
      const agent = listAgentEntries(config)[0]!;
      const remove = () =>
        withClawAgentConfigRemoval(
          {
            agentId: "worker",
            expectedDigest: digestClawAgentConfig(agent),
            expectedRemovalSurfaceDigest: digestClawAgentRemovalSurface(config, "worker"),
            expectedState: "present",
            fallbackWorkspace: agent.workspace!,
            config,
            stateDatabase: { env },
            onModified: () => new Error("agent modified"),
          },
          (commitRemoval) => commitRemoval(),
        );
      if (failClose) {
        vi.spyOn(owned.walMaintenance, "close").mockImplementationOnce(() => {
          throw new Error("retained close failure");
        });
        await expect(remove()).rejects.toThrow("retained close failure");
        expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(originalConfig);
        expect(owned.db.isOpen).toBe(true);
        expect(readAgentDeletionJournal("worker", { env })).toBeUndefined();
      }
      await expect(remove()).resolves.toMatchObject({ agentRemoved: true });
      expect(owned.db.isOpen).toBe(false);
      expect(relocated.db.isOpen).toBe(false);
      expect(foreign.db.isOpen).toBe(true);
    },
  );

  it.each([
    { kind: "agentState", schemaVersion: undefined },
    { kind: "sessionTranscripts", schemaVersion: 1 },
    { kind: "workspace", schemaVersion: 999 },
  ])(
    "refreshes closed foreign ownership before cleaning $kind (schema: $schemaVersion)",
    async ({ kind, schemaVersion }) => {
      const addPlan = await buildApprovalFixture();
      await withTempHomeConfig({}, async ({ home }) => {
        setTestEnvValue("OPENCLAW_STATE_DIR", join(home, ".openclaw"));
        let config: OpenClawConfig = {};
        const commitConfig = async (transform: (current: OpenClawConfig) => OpenClawConfig) => {
          config = transform(config);
        };
        await applyClawAddPlan(addPlan, {
          consentPlanIntegrity: addPlan.planIntegrity,
          commitConfig,
        });
        await writeOpenClawConfig(home, config);
        const sharedDir =
          kind === "workspace"
            ? addPlan.agent.workspace
            : join(
                home,
                ".openclaw",
                "agents",
                "worker",
                kind === "agentState" ? "agent" : "sessions",
              );
        const foreignPath = join(sharedDir, "kept.sqlite");
        expect(listOpenClawRegisteredAgentDatabases()).toEqual([]);
        const child = startHeldDatabase("kept", foreignPath);
        try {
          await child.ready;
          await child.close();
        } finally {
          await child.dispose();
        }
        if (schemaVersion !== undefined) {
          registerOpenClawAgentDatabase({ agentId: "kept", path: foreignPath, schemaVersion });
        }
        const before = await stat(foreignPath);
        const plan = await buildClawRemovePlan("worker", { config });
        expect(plan.actions).toContainEqual(
          expect.objectContaining({
            kind,
            target: sharedDir,
            action: "retain",
            reason: expect.stringContaining("another agent"),
          }),
        );
        const trashPath = vi.fn(async () => true);
        await expect(
          applyClawRemovePlan(plan, {
            monitorGateway: quiescentClawMonitorGateway,
            config,
            trashPath,
            consentPlanIntegrity: plan.planIntegrity,
          }),
        ).resolves.toMatchObject({ status: "complete" });
        expect(trashPath).not.toHaveBeenCalledWith(sharedDir, expect.anything());
        expect((await stat(foreignPath)).ino).toBe(before.ino);
      });
    },
  );

  it.each([
    { label: "complete cleanup", complete: true },
    { label: "partial cleanup", complete: false },
  ])("removes only the claw agent policy through $label", async ({ complete }) => {
    const addPlan = await buildApprovalFixture();

    await withTempHomeConfig({}, async ({ home }) => {
      const env = { OPENCLAW_STATE_DIR: join(home, ".openclaw") };
      setTestEnvValue("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      let config: OpenClawConfig = {};
      await applyClawAddPlan(addPlan, {
        consentPlanIntegrity: addPlan.planIntegrity,
        env,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      });
      await writeOpenClawConfig(home, config);
      saveExecApprovals({
        version: 1,
        agents: {
          "*": { security: "deny" },
          worker: {
            security: "allowlist",
            allowlist: [{ pattern: "/usr/bin/rm" }],
          },
          kept: {
            security: "allowlist",
            allowlist: [{ pattern: "/usr/bin/keep" }],
          },
        },
      });
      const plan = await buildClawRemovePlan("worker");
      const result = await applyClawRemovePlan(plan, {
        monitorGateway: quiescentClawMonitorGateway,
        consentPlanIntegrity: plan.planIntegrity,
        trashPath: async () => complete,
      });

      expect(result).toMatchObject({
        status: complete ? "complete" : "partial",
        agentRemoved: true,
      });
      expect(loadExecApprovals().agents).toEqual({
        "*": { security: "deny" },
        kept: {
          security: "allowlist",
          allowlist: [expect.objectContaining({ pattern: "/usr/bin/keep" })],
        },
      });
      expect(readAgentDeletionJournal("worker")).toMatchObject({
        cleanupCompleted: complete,
        deleteFiles: false,
      });
      expect(readAgentProvenance("worker")?.createdVia).toBe(complete ? undefined : "claw");
    });
  });

  it("blocks recreating the agent until destructive cleanup finishes", async () => {
    const addPlan = await buildApprovalFixture();

    await withTempHomeConfig({}, async ({ home }) => {
      const env = { OPENCLAW_STATE_DIR: join(home, ".openclaw") };
      setTestEnvValue("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      let config: OpenClawConfig = {};
      await applyClawAddPlan(addPlan, {
        consentPlanIntegrity: addPlan.planIntegrity,
        env,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      });
      await writeOpenClawConfig(home, config);
      const plan = await buildClawRemovePlan("worker");
      let creationDuringCleanup: Awaited<ReturnType<typeof createAgent>> | undefined;

      const result = await applyClawRemovePlan(plan, {
        monitorGateway: quiescentClawMonitorGateway,
        consentPlanIntegrity: plan.planIntegrity,
        trashPath: async () => {
          creationDuringCleanup ??= await createAgent({
            name: "worker",
            workspace: join(home, "replacement-worker"),
          });
          return true;
        },
      });

      expect(creationDuringCleanup).toMatchObject({
        status: "error",
        reason: "deletion-pending",
      });
      expect(result).toMatchObject({ status: "complete", agentRemoved: true });
      expect(readAgentDeletionJournal("worker")).toMatchObject({ cleanupCompleted: true });
    });
  });

  it("keeps the Claw retry owner when deletion journal completion is interrupted", async () => {
    const addPlan = await buildApprovalFixture();

    await withTempHomeConfig({}, async ({ home }) => {
      const env = { OPENCLAW_STATE_DIR: join(home, ".openclaw") };
      setTestEnvValue("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      let config: OpenClawConfig = {};
      await applyClawAddPlan(addPlan, {
        consentPlanIntegrity: addPlan.planIntegrity,
        env,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      });
      await writeOpenClawConfig(home, config);
      const plan = await buildClawRemovePlan("worker", { env, config });
      const state = openOpenClawStateDatabase({ env });
      state.db.exec(`
        CREATE TRIGGER fail_claw_deletion_completion
        BEFORE UPDATE OF cleanup_completed ON agent_deletion_journal
        WHEN NEW.cleanup_completed = 1
        BEGIN
          SELECT RAISE(ABORT, 'injected deletion journal completion failure');
        END;
      `);

      await expect(
        applyClawRemovePlan(plan, {
          monitorGateway: quiescentClawMonitorGateway,
          consentPlanIntegrity: plan.planIntegrity,
          env,
          config,
          trashPath: async () => true,
        }),
      ).resolves.toMatchObject({
        status: "partial",
        agentRemoved: true,
        error: { message: expect.stringContaining("injected deletion journal completion failure") },
      });

      expect(readAgentDeletionJournal("worker", { env })).toMatchObject({
        cleanupCompleted: false,
      });
      await expect(readClawStatus("worker", { env, config })).resolves.toMatchObject({
        records: [
          expect.objectContaining({ install: expect.objectContaining({ agentId: "worker" }) }),
        ],
      });
    });
  });

  it("rechecks shared session ownership after resource cleanup changes config", async () => {
    const root = tempDirs.make("claw-remove-shared-topology-");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const workspace = join(root, "workspace-worker");
    const sharedPath = join(root, "shared.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "worker", path: sharedPath, env });
    closeOpenClawAgentDatabaseByPath(database.path);
    const initialConfig: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { worker: { workspace }, kept: {} } },
    };
    const configPath = join(root, "openclaw.json");
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    setTestEnvValue("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    await writeFile(configPath, JSON.stringify(initialConfig));

    await expect(
      withClawAgentConfigRemoval(
        {
          agentId: "worker",
          expectedDigest: digestClawAgentConfig({ id: "worker", workspace }),
          expectedRemovalSurfaceDigest: digestClawAgentRemovalSurface(initialConfig, "worker"),
          expectedState: "present",
          fallbackWorkspace: workspace,
          config: initialConfig,
          stateDatabase: { env },
          onModified: () => new Error("agent changed"),
        },
        async (commitRemoval) => {
          await writeFile(
            configPath,
            JSON.stringify({ ...initialConfig, session: { store: sharedPath } }),
          );
          return await commitRemoval();
        },
      ),
    ).rejects.toThrow('still used by agent "kept"');
    const persistedConfig = JSON.parse(await readFile(configPath, "utf8")) as OpenClawConfig;
    expect(listAgentEntries(persistedConfig).map((entry) => entry.id)).toEqual(["worker", "kept"]);
    expect(persistedConfig.session?.store).toBe(sharedPath);
    expect(readAgentDeletionJournal("worker", { env })).toBeUndefined();
  });

  // A failed retry must retain the journal left by the original deletion.
  it.each([
    { label: "keeps a pre-existing journal", seedJournal: true },
    { label: "rolls back the journal it opened", seedJournal: false },
  ])("$label when the config commit rejects a changed agent", async ({ seedJournal }) => {
    const root = tempDirs.make("openclaw-claw-remove-journal-");
    setTestEnvValue("OPENCLAW_STATE_DIR", join(root, "state"));
    const config: OpenClawConfig = {
      agents: { entries: { worker: { workspace: join(root, "workspace") } } },
    };
    const configPath = join(root, "openclaw.json");
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    await writeFile(configPath, JSON.stringify(config));
    if (seedJournal) {
      beginAgentDeletionJournal({
        agentId: "worker",
        operationId: "prior-deletion",
        deleteFiles: false,
        agentDir: join(root, "agent"),
        workspaceDir: join(root, "workspace"),
        sessionsDir: join(root, "sessions"),
      });
    }

    await expect(
      withClawAgentConfigRemoval(
        {
          agentId: "worker",
          expectedDigest: "sha256:unused",
          expectedRemovalSurfaceDigest: digestClawAgentRemovalSurface(config, "worker"),
          expectedState: "present",
          fallbackWorkspace: join(root, "workspace"),
          config,
          onModified: () => new Error("claw agent modified"),
        },
        (commitRemoval) => commitRemoval(),
      ),
    ).rejects.toThrow("claw agent modified");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(config);

    expect(readAgentDeletionJournal("worker") === undefined).toBe(!seedJournal);
  });
});
