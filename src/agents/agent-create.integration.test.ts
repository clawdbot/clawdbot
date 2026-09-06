import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  mutateConfigFileWithRetry,
  transformConfigFileWithRetry,
  withConfigMutationExclusive,
} from "../config/config.js";
import { migrateLegacyMainSessionKeys } from "../config/sessions/legacy-main-session-migration.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import { readExactSessionEntryRowForCanonicalRepair } from "../config/sessions/session-accessor.sqlite-canonical-repair.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { readAgentProvenance } from "../state/agent-provenance.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { executeSystemAgentOperation } from "../system-agent/operations-execute.js";
import { createSystemAgentTestRuntime } from "../system-agent/system-agent.runtime.test-support.js";
import { nodeFilePath } from "../test-utils/node-file-path.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAgent } from "./agent-create.js";
import { beginAgentDeletion } from "./agent-lifecycle-registry.js";
import { resolveSharedAuthStorePath } from "./auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import { readWorkspaceStateSnapshot } from "./workspace-state-store.js";
import {
  DEFAULT_IDENTITY_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceBootstrapPending,
} from "./workspace.js";

it("does not create an agent after delegated authority closes while awaiting the config lock", async () => {
  const state = await createOpenClawTestState({
    scenario: "minimal",
    label: "agent-create-closed-authority",
  });
  const authority = claimAgentRunDelegatedAuthority({
    instanceId: "creation-instance",
    runId: "creation-run",
  });
  const lockEntered = createDeferred();
  const releaseLock = createDeferred();
  const creationEntered = createDeferred();
  const { runtime, lines } = createSystemAgentTestRuntime();
  const workspace = state.path("delegated-workspace");
  const originalConfig = await fs.readFile(state.configPath, "utf8");
  const lock = withConfigMutationExclusive(async () => {
    lockEntered.resolve();
    await releaseLock.promise;
  });
  let creation: Promise<unknown> | undefined;
  try {
    await lockEntered.promise;
    creation = executeSystemAgentOperation(
      { kind: "create-agent", agentId: "delegated", workspace, requesterAgentId: "main" },
      runtime,
      {
        approved: true,
        beforePersistentApply: () => {
          if (!validateAgentRunDelegatedAuthority(authority)) {
            throw new Error("system-agent approval authority is no longer active");
          }
          creationEntered.resolve();
        },
      },
    );
    const outcome = creation.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await creationEntered.promise;
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    releaseLock.resolve();
    await lock;

    expect.soft(await outcome).toMatchObject({
      error: new Error("system-agent approval authority is no longer active"),
    });
    expect.soft(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
    expect.soft(await fs.stat(workspace).catch(() => null)).toBeNull();
    expect.soft(await fs.stat(state.sessionsDir("delegated")).catch(() => null)).toBeNull();
    expect.soft(readAgentProvenance("delegated", { env: state.env })).toBeUndefined();
    expect.soft(lines).not.toContain("[openclaw] done: agents.create");
  } finally {
    releaseLock.resolve();
    await lock;
    await creation?.catch(() => undefined);
    releaseAgentRunDelegatedAuthority(authority);
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it.each(["workspace", "workspace-write", "config"] as const)(
  "stops delegated creation after authority closes during %s preparation",
  async (phase) => {
    const state = await createOpenClawTestState({
      scenario: "minimal",
      label: `agent-create-${phase}-authority`,
    });
    const authority = claimAgentRunDelegatedAuthority({
      instanceId: "preparation-instance",
      runId: "preparation-run",
    });
    const entered = createDeferred();
    const resume = createDeferred();
    const workspace = state.path("prepared-workspace");
    const stagedFile = state.path("staged-effect");
    const originalConfig = await fs.readFile(state.configPath, "utf8");
    const pause = async () => {
      entered.resolve();
      await resume.promise;
    };
    const realAccess = fs.access.bind(fs);
    const access = vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
      if (phase === "workspace" && file === path.join(workspace, "AGENTS.md")) {
        await pause();
      }
      return await realAccess(file, mode);
    });
    const realWrite = fs.writeFile.bind(fs);
    const write = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      await realWrite(file, data, options);
      const filePath = nodeFilePath(file);
      if (
        phase === "workspace-write" &&
        filePath &&
        path.basename(filePath) === "AGENTS.md" &&
        path.basename(path.dirname(filePath)).startsWith("openclaw-bootstrap-")
      ) {
        await pause();
      }
    });
    const rollback = vi.fn(async () => await fs.rm(stagedFile));
    const prepareConfigCommit = vi.fn(async () => {
      await fs.writeFile(stagedFile, "staged before publication");
      await pause();
      return rollback;
    });
    const creation = createAgent({
      name: "prepared",
      workspace,
      beforePersistentApply: () => {
        if (!validateAgentRunDelegatedAuthority(authority)) {
          throw new Error("creation authority closed");
        }
      },
      prepareConfigCommit,
    });
    const outcome = creation.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await withTestTimeout(entered.promise, 10_000, "creation did not reach preparation pause");
      expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
      resume.resolve();

      expect.soft(await outcome).toMatchObject({ error: new Error("creation authority closed") });
      expect.soft(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
      expect.soft(readAgentProvenance("prepared")).toBeUndefined();
      expect.soft(rollback).toHaveBeenCalledTimes(phase === "config" ? 1 : 0);
      expect.soft(await fs.stat(stagedFile).catch(() => null)).toBeNull();
      if (phase !== "config") {
        expect.soft(await fs.readdir(workspace)).toEqual([]);
        expect.soft(readWorkspaceStateSnapshot(workspace).setupExists).toBe(false);
        expect.soft(prepareConfigCommit).not.toHaveBeenCalled();
        expect.soft(await fs.stat(state.sessionsDir("prepared")).catch(() => null)).toBeNull();
      } else {
        // Completed workspace/session effects are not rolled back with staged config work.
        expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).not.toBe("");
        expect((await fs.stat(state.sessionsDir("prepared"))).isDirectory()).toBe(true);
      }
    } finally {
      resume.resolve();
      await outcome;
      write.mockRestore();
      access.mockRestore();
      releaseAgentRunDelegatedAuthority(authority);
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  },
);

it("finishes creation bookkeeping when delegated authority closes after successful publication", async () => {
  const state = await createOpenClawTestState({
    scenario: "minimal",
    label: "agent-create-published",
  });
  const authority = claimAgentRunDelegatedAuthority({
    instanceId: "published",
    runId: "published",
  });
  const workspace = state.path("published-workspace");
  const deletion = beginAgentDeletion({
    agentId: "published",
    agentDir: state.agentDir("published"),
    workspaceDir: workspace,
    sessionsDir: state.sessionsDir("published"),
    deleteFiles: false,
  });
  deletion.finish();
  const rollback = vi.fn();
  try {
    const created = await createAgent({
      name: "published",
      workspace,
      beforePersistentApply: () => {
        if (!validateAgentRunDelegatedAuthority(authority)) {
          throw new Error("creation authority closed");
        }
      },
      prepareConfigCommit: async () => rollback,
      transformConfig: async (params) => {
        const result = await transformConfigFileWithRetry(params);
        releaseAgentRunDelegatedAuthority(authority);
        return result;
      },
    });

    expect(created).toMatchObject({ status: "created", agentId: "published" });
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toHaveProperty(
      "agents.entries.published",
    );
    expect(readAgentDeletionJournal("published")).toBeUndefined();
    expect(readAgentProvenance("published")).toMatchObject({ createdVia: "operator" });
    expect(rollback).not.toHaveBeenCalled();
  } finally {
    deletion.rollback();
    releaseAgentRunDelegatedAuthority(authority);
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it("keeps a fresh named workspace pending through the first run setup", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "minimal",
    label: "named-agent-hatch",
  });
  const workspace = state.path("named-workspace");

  try {
    const created = await createAgent({ name: "Researcher", workspace });

    expect(created).toMatchObject({ status: "created", bootstrapPending: true });
    expect(await isWorkspaceBootstrapPending(workspace)).toBe(true);

    const firstRunWorkspace = await ensureAgentWorkspace({
      dir: workspace,
      ensureBootstrapFiles: true,
    });
    expect(firstRunWorkspace.bootstrapPending).toBe(true);
    expect(await isWorkspaceBootstrapPending(workspace)).toBe(true);
    expect(
      await fs.readFile(path.join(workspace, DEFAULT_IDENTITY_FILENAME), "utf8"),
    ).not.toContain("Researcher");
  } finally {
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it("records operator and agent creation provenance after roster commits", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "empty",
    label: "agent-creation-provenance",
  });
  try {
    await createAgent({ name: "Operator Child", workspace: state.path("operator-child") });
    await createAgent({
      name: "Agent Child",
      workspace: state.path("agent-child"),
      provenance: { createdVia: "agent", creatorAgentId: "main" },
    });

    expect(readAgentProvenance("operator-child", { env: state.env })).toMatchObject({
      agentId: "operator-child",
      createdVia: "operator",
      creatorAgentId: null,
      createdAtMs: expect.any(Number),
    });
    expect(readAgentProvenance("agent-child", { env: state.env })).toMatchObject({
      agentId: "agent-child",
      createdVia: "agent",
      creatorAgentId: "main",
      createdAtMs: expect.any(Number),
    });
  } finally {
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

describe("agent roster persistence", () => {
  async function addWorkerToConfig(config: unknown): Promise<OpenClawConfig> {
    const state = await createOpenClawTestState({
      layout: "state-only",
      scenario: "empty",
      label: "agent-roster-write",
    });
    try {
      await state.writeConfig(config);
      const result = await createAgent({ name: "Worker", workspace: state.path("worker") });
      expect(result).toMatchObject({ status: "created", agentId: "worker" });
      return JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    } finally {
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  }

  it("writes injected main and a new worker as one complete keyed roster", async () => {
    const persisted = await addWorkerToConfig({ gateway: { mode: "local" } });

    expect(persisted.agents?.entries?.main).toMatchObject({ workspace: expect.any(String) });
    expect(persisted.agents?.entries?.worker).toMatchObject({ workspace: expect.any(String) });
    expect(Object.values(persisted.agents?.entries ?? {})).not.toContainEqual(
      expect.objectContaining({ default: expect.anything() }),
    );
  });

  it("replaces a legacy list with the complete keyed roster", async () => {
    const persisted = await addWorkerToConfig({
      agents: {
        list: [
          { id: "main", default: true },
          { id: "ops", workspace: "/srv/ops" },
        ],
      },
    });

    expect(persisted.agents).not.toHaveProperty("list");
    expect(persisted.agents?.entries?.main).toMatchObject({ workspace: expect.any(String) });
    expect(persisted.agents?.entries).toMatchObject({
      ops: { workspace: "/srv/ops" },
      worker: { workspace: expect.any(String) },
    });
  });

  it("preserves a legacy list byte-for-byte during a non-roster mutation", async () => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      scenario: "empty",
      label: "legacy-roster-non-roster-write",
    });
    const list = [
      { id: "main", default: true },
      { id: "ops", workspace: "/srv/ops" },
    ];
    try {
      await state.writeConfig({ agents: { list }, gateway: { port: 18789 } });
      await mutateConfigFileWithRetry({
        mutate: (config) => {
          config.gateway = { ...config.gateway, port: 19001 };
        },
      });

      const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
      expect(JSON.stringify(persisted.agents?.list)).toBe(JSON.stringify(list));
      expect(persisted.agents).not.toHaveProperty("entries");
      expect(persisted.gateway?.port).toBe(19001);
    } finally {
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  });
});

it("creates main as an ordinary fresh agent after doctor completes both ownership handoffs", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "empty",
    label: "ordinary-main-agent",
  });
  const cfg: OpenClawConfig = {
    agents: { entries: { robby: { workspace: state.path("workspace-robby") } } },
  };
  const legacyDatabasePath = path.join(state.agentDir("main"), "openclaw-agent.sqlite");
  const ownerDatabasePath = path.join(state.agentDir("robby"), "openclaw-agent.sqlite");
  const legacyKey = "agent:main:main";
  const canonicalKey = "agent:robby:main";
  const lateLegacyKey = "agent:main:late";
  const lateCanonicalKey = "agent:robby:late";

  try {
    await state.writeConfig(cfg);
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(
          database,
          legacyKey,
          { sessionId: "legacy-before-main-reuse", updatedAt: 100 },
          { allowStoredAliases: true, previousEntry: null },
        );
      },
      { agentId: "main", env: state.env, path: legacyDatabasePath },
    );
    await migrateLegacyMainSessionKeys({ cfg, env: state.env, mode: "doctor-fix" });
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: state.env });
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(
          database,
          lateLegacyKey,
          { sessionId: "late-legacy-before-main-reuse", updatedAt: 200 },
          { allowStoredAliases: true, previousEntry: null },
        );
      },
      { agentId: "main", env: state.env, path: legacyDatabasePath },
    );

    const blocked = await createAgent({ name: "main", workspace: state.path("workspace-main") });
    expect(blocked).toMatchObject({
      status: "error",
      reason: "legacy-session-migration-required",
    });
    expect(
      runOpenClawAgentWriteTransaction(
        (database) => readExactSessionEntryRowForCanonicalRepair(database, lateLegacyKey)?.entry,
        { agentId: "main", env: state.env, path: legacyDatabasePath },
      ),
    ).toMatchObject({ sessionId: "late-legacy-before-main-reuse" });

    await migrateLegacyMainSessionKeys({ cfg, env: state.env, mode: "doctor-fix" });

    const created = await createAgent({ name: "main", workspace: state.path("workspace-main") });

    expect(created).toMatchObject({ status: "created", agentId: "main" });
    if (created.status !== "created") {
      throw new Error(`expected main creation, got ${JSON.stringify(created)}`);
    }
    const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    const mainSessionTarget = resolveSqliteTargetFromSessionStorePath(
      resolveSessionStorePathCore(persisted.session?.store, { agentId: "main", env: state.env }),
      { agentId: "main", env: state.env },
    );
    expect(mainSessionTarget).toMatchObject({ agentId: "main", path: legacyDatabasePath });
    expect(resolveAuthProfileDatabasePath(created.agentDir)).toBe(legacyDatabasePath);
    expect(resolveSharedAuthStorePath(state.env)).toBe(resolveOpenClawStateSqlitePath(state.env));
    expect(resolveAuthProfileDatabasePath(created.agentDir)).not.toBe(
      resolveSharedAuthStorePath(state.env),
    );
    expect(
      listSessionEntriesReadOnly({
        agentId: "main",
        env: state.env,
        storePath: legacyDatabasePath,
      }).filter((entry) => entry.sessionKey.startsWith("agent:main:")),
    ).toEqual([]);
    expect(
      runOpenClawAgentWriteTransaction(
        (database) => readExactSessionEntryRowForCanonicalRepair(database, canonicalKey)?.entry,
        { agentId: "robby", env: state.env, path: ownerDatabasePath },
      ),
    ).toMatchObject({ sessionId: "legacy-before-main-reuse" });
    expect(
      runOpenClawAgentWriteTransaction(
        (database) => readExactSessionEntryRowForCanonicalRepair(database, lateCanonicalKey)?.entry,
        { agentId: "robby", env: state.env, path: ownerDatabasePath },
      ),
    ).toMatchObject({ sessionId: "late-legacy-before-main-reuse" });
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});
