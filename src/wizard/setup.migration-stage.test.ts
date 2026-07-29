// Setup migration stage tests cover isolated SQLite writes and promotion rollback.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import type { MigrationPlan } from "../plugins/types.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry.js";
import type { SetupMigrationPromotionContinuation } from "./setup.migration-promotion.js";
import {
  createSetupMigrationStage,
  recoverSetupMigrationPromotion,
} from "./setup.migration-stage.js";

const tempRoots = new Set<string>();

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migration-stage-"));
  tempRoots.add(root);
  return root;
}

function configHash(config: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function continuation(): Omit<
  SetupMigrationPromotionContinuation,
  "workspaceDir" | "stagedReportDir" | "stagedRoots"
> {
  const plan = {
    providerId: "claude",
    source: "fixture",
    items: [],
    summary: {
      total: 0,
      planned: 0,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
  };
  return {
    providerLabel: "Claude",
    plan,
    stagedResult: plan,
    outcome: { kind: "no-imported-inference" },
    continueOnboarding: true,
  };
}

afterEach(async () => {
  const [{ closeOpenClawAgentDatabasesForTest }, { closeOpenClawStateDatabaseForTest }] =
    await Promise.all([
      import("../state/openclaw-agent-db.js"),
      import("../state/openclaw-state-db.js"),
    ]);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("setup migration stage", () => {
  it("executes provider config mutations once and projects staged paths", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const reportDir = path.join(stateDir, "migration", "claude", "attempt");
    const stage = await createSetupMigrationStage({
      providerId: "claude",
      stateDir,
      workspaceDir,
      reportDir,
      targetConfig: { agents: { defaults: { workspace: workspaceDir } } },
    });
    let mutationCalls = 0;

    await stage.configRuntime.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "none", reason: "staged migration test" },
      mutate(draft) {
        mutationCalls += 1;
        draft.mcp = {
          servers: {
            staged: { command: stage.staged.workspaceDir },
          },
        };
      },
    });

    expect(mutationCalls).toBe(1);
    expect(stage.getStagedConfig().mcp?.servers?.staged?.command).toBe(stage.staged.workspaceDir);
    expect(stage.getFinalConfig().mcp?.servers?.staged?.command).toBe(workspaceDir);
    await stage.cleanup();
  });

  it("uses the most-specific path mapping when workspace lives under state", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(stateDir, "workspace");
    const stage = await createSetupMigrationStage({
      providerId: "claude",
      stateDir,
      workspaceDir,
      reportDir: path.join(stateDir, "migration", "claude", "attempt"),
      targetConfig: { agents: { defaults: { workspace: workspaceDir } } },
    });
    const target = path.join(workspaceDir, "MEMORY.md");
    const plan = {
      providerId: "claude",
      source: "fixture",
      target,
      items: [
        {
          id: "workspace:memory",
          kind: "memory",
          action: "copy",
          status: "planned",
          target,
        },
      ],
      summary: {
        total: 1,
        planned: 1,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
    } satisfies MigrationPlan;

    const projected = stage.projectPlanToStage(plan);

    expect(projected.target).toBe(path.join(stage.staged.workspaceDir, "MEMORY.md"));
    expect(projected.items[0]?.target).toBe(path.join(stage.staged.workspaceDir, "MEMORY.md"));
    await stage.cleanup();
  });

  it("routes staged auth writes to the staged shared registry", async () => {
    const root = await makeTempRoot();
    const liveStateDir = path.join(root, "live-state");
    const stagedStateDir = path.join(root, "staged-state");
    const stagedAgentDir = path.join(stagedStateDir, "agents", "main", "agent");

    const updated = await updateAuthProfileStoreWithLock({
      agentDir: stagedAgentDir,
      stateDir: stagedStateDir,
      updater(store) {
        store.profiles["openai:imported"] = {
          type: "api_key",
          provider: "openai",
          key: "test-key",
        };
        return true;
      },
    });

    expect(updated?.profiles["openai:imported"]).toBeDefined();
    expect(
      listOpenClawRegisteredAgentDatabases({
        env: { ...process.env, OPENCLAW_STATE_DIR: stagedStateDir },
      }),
    ).toEqual([
      expect.objectContaining({
        agentId: "main",
        path: path.join(stagedAgentDir, "openclaw-agent.sqlite"),
      }),
    ]);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env: { ...process.env, OPENCLAW_STATE_DIR: liveStateDir },
      }),
    ).toEqual([]);
    await expect(fs.access(path.join(liveStateDir, "state", "openclaw.sqlite"))).rejects.toThrow();
  });

  it("promotes the final agent registry path after verification closes the handle", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const reportDir = path.join(stateDir, "migration", "claude", "attempt");
    const targetConfig = { agents: { defaults: { workspace: workspaceDir } } };
    const stage = await createSetupMigrationStage({
      providerId: "claude",
      stateDir,
      workspaceDir,
      reportDir,
      targetConfig,
    });
    const { disposeOpenClawAgentDatabaseByPath } = await import("../state/openclaw-agent-db.js");
    disposeOpenClawAgentDatabaseByPath(path.join(stage.staged.agentDir, "openclaw-agent.sqlite"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stage.staged.stateDir },
    });

    const promoted = await stage.promote({
      expectedConfig: {},
      continuation: continuation(),
      readConfigFile: async () => ({}),
      commitConfigFile: async (config) => config,
    });

    expect(
      listOpenClawRegisteredAgentDatabases({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toEqual([
      expect.objectContaining({
        agentId: "main",
        path: path.join(stage.final.agentDir, "openclaw-agent.sqlite"),
      }),
    ]);
    await promoted.resume.complete();
    await promoted.resume.acknowledge();
    await stage.cleanup();
  });

  it("rolls back promoted directories when the config commit fails", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const reportDir = path.join(stateDir, "migration", "claude", "attempt");
    await fs.mkdir(path.join(stateDir, "migration"), { recursive: true });
    const stage = await createSetupMigrationStage({
      providerId: "claude",
      stateDir,
      workspaceDir,
      reportDir,
      targetConfig: { agents: { defaults: { workspace: workspaceDir } } },
    });
    await fs.writeFile(path.join(stage.staged.workspaceDir, "MEMORY.md"), "staged\n", "utf8");

    await expect(
      stage.promote({
        expectedConfig: {},
        continuation: continuation(),
        readConfigFile: async () => ({}),
        commitConfigFile: async () => {
          throw new Error("commit failed");
        },
      }),
    ).rejects.toThrow("commit failed");

    await expect(fs.access(path.join(workspaceDir, "MEMORY.md"))).rejects.toThrow();
    await expect(fs.access(path.join(stateDir, "agents"))).rejects.toThrow();
    const journalPath = path.join(reportDir, "onboarding-promotion.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as { status: string };
    expect(journal.status).toBe("rolled-back");
    expect((await fs.stat(journalPath)).mode & 0o777).toBe(0o600);
    await stage.cleanup();
  });

  it("journals pre-existing empty targets before promotion starts", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const reportDir = path.join(stateDir, "migration", "claude", "attempt");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.chmod(workspaceDir, 0o755);
    const stage = await createSetupMigrationStage({
      providerId: "claude",
      stateDir,
      workspaceDir,
      reportDir,
      targetConfig: { agents: { defaults: { workspace: workspaceDir } } },
    });
    await fs.writeFile(path.join(stage.staged.workspaceDir, "MEMORY.md"), "staged\n", "utf8");

    await expect(
      stage.promote({
        expectedConfig: {},
        continuation: continuation(),
        readConfigFile: async () => ({}),
        commitConfigFile: async () => {
          throw new Error("commit failed");
        },
      }),
    ).rejects.toThrow("commit failed");

    const journal = JSON.parse(
      await fs.readFile(path.join(reportDir, "onboarding-promotion.json"), "utf8"),
    ) as {
      components: Array<{
        name: string;
        targetWasEmptyDirectory?: boolean;
        emptyTargetBackupPath?: string;
      }>;
    };
    expect(journal.components.find((component) => component.name === "workspace")).toMatchObject({
      targetWasEmptyDirectory: true,
      emptyTargetBackupPath: expect.any(String),
    });
    expect(await fs.readdir(workspaceDir)).toEqual([]);
    expect((await fs.stat(workspaceDir)).mode & 0o777).toBe(0o755);
    await stage.cleanup();
  });

  it("removes shared promotion parents after rollback", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const sharedRoot = path.join(stateDir, "shared");
    const workspaceDir = path.join(sharedRoot, "workspace");
    const agentDir = path.join(sharedRoot, "agent");
    const reportDir = path.join(stateDir, "migration", "claude", "attempt");
    const targetConfig = {
      agents: {
        defaults: { workspace: workspaceDir },
        list: [{ id: "main", default: true, agentDir }],
      },
    };
    const stage = await createSetupMigrationStage({
      providerId: "claude",
      stateDir,
      workspaceDir,
      reportDir,
      targetConfig,
    });
    await fs.writeFile(path.join(stage.staged.workspaceDir, "MEMORY.md"), "staged\n", "utf8");

    await expect(
      stage.promote({
        expectedConfig: {},
        continuation: continuation(),
        readConfigFile: async () => ({}),
        commitConfigFile: async () => {
          throw new Error("commit failed");
        },
      }),
    ).rejects.toThrow("commit failed");

    await expect(fs.access(sharedRoot)).rejects.toThrow();
    await stage.cleanup();
  });

  it("rejects staged state that the promotion owner does not publish", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const reportDir = path.join(stateDir, "migration", "claude", "attempt");
    const stage = await createSetupMigrationStage({
      providerId: "claude",
      stateDir,
      workspaceDir,
      reportDir,
      targetConfig: { agents: { defaults: { workspace: workspaceDir } } },
    });
    await fs.mkdir(path.join(stage.staged.stateDir, "credentials"), { recursive: true });
    await fs.writeFile(
      path.join(stage.staged.stateDir, "credentials", "provider.json"),
      "{}\n",
      "utf8",
    );

    await expect(
      stage.promote({
        expectedConfig: {},
        continuation: continuation(),
        readConfigFile: async () => ({}),
        commitConfigFile: async (config) => config,
      }),
    ).rejects.toThrow("unsupported staged state");
    await stage.cleanup();
  });

  it("rejects overlapping workspace and agent promotion targets", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(stateDir, "agents", "main", "agent", "workspace");
    const reportDir = path.join(stateDir, "migration", "claude", "attempt");
    const stage = await createSetupMigrationStage({
      providerId: "claude",
      stateDir,
      workspaceDir,
      reportDir,
      targetConfig: { agents: { defaults: { workspace: workspaceDir } } },
    });
    await fs.writeFile(path.join(stage.staged.workspaceDir, "MEMORY.md"), "staged\n", "utf8");

    await expect(
      stage.promote({
        expectedConfig: {},
        continuation: continuation(),
        readConfigFile: async () => ({}),
        commitConfigFile: async (config) => config,
      }),
    ).rejects.toThrow("Migration promotion targets overlap");
    await expect(fs.access(path.join(reportDir, "onboarding-promotion.json"))).rejects.toThrow();
    await stage.cleanup();
  });

  it("rejects overlap through a state-directory symlink", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const stateAlias = path.join(root, "state-alias");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.symlink(stateDir, stateAlias);
    const workspaceDir = path.join(stateAlias, "agents", "main", "agent", "workspace");
    const reportDir = path.join(stateDir, "migration", "claude", "attempt");
    const stage = await createSetupMigrationStage({
      providerId: "claude",
      stateDir,
      workspaceDir,
      reportDir,
      targetConfig: { agents: { defaults: { workspace: workspaceDir } } },
    });
    await fs.writeFile(path.join(stage.staged.workspaceDir, "MEMORY.md"), "staged\n", "utf8");

    await expect(
      stage.promote({
        expectedConfig: {},
        continuation: continuation(),
        readConfigFile: async () => ({}),
        commitConfigFile: async (config) => config,
      }),
    ).rejects.toThrow("Migration promotion targets overlap");
    await expect(fs.access(path.join(reportDir, "onboarding-promotion.json"))).rejects.toThrow();
    await stage.cleanup();
  });

  it("rejects a report path that resolves inside a promotion target", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const reportDir = path.join(stateDir, "migration", "claude", "attempt");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.symlink(workspaceDir, path.join(stateDir, "migration"));
    const stage = await createSetupMigrationStage({
      providerId: "claude",
      stateDir,
      workspaceDir,
      reportDir,
      targetConfig: { agents: { defaults: { workspace: workspaceDir } } },
    });
    await fs.writeFile(path.join(stage.staged.workspaceDir, "MEMORY.md"), "staged\n", "utf8");

    await expect(
      stage.promote({
        expectedConfig: {},
        continuation: continuation(),
        readConfigFile: async () => ({}),
        commitConfigFile: async (config) => config,
      }),
    ).rejects.toThrow("Migration promotion targets overlap");
    expect(await fs.readdir(workspaceDir)).toEqual([]);
    await stage.cleanup();
  });

  it("fails closed when an interrupted promotion already published data", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const reportDir = path.join(stateDir, "migration", "claude", "2026-07-21T000000Z");
    const stagedWorkspace = path.join(root, "staged-workspace");
    const finalWorkspace = path.join(root, "workspace");
    await fs.mkdir(reportDir, { recursive: true });
    await fs.mkdir(finalWorkspace, { recursive: true });
    await fs.writeFile(path.join(finalWorkspace, "MEMORY.md"), "promoted\n", "utf8");
    await fs.writeFile(
      path.join(reportDir, "onboarding-promotion.json"),
      JSON.stringify({
        version: 1,
        status: "promoting",
        providerId: "claude",
        configHashBefore: configHash({}),
        configHashTarget: configHash({ gateway: { mode: "local" } }),
        components: [
          {
            name: "workspace",
            stagedPath: stagedWorkspace,
            finalPath: finalWorkspace,
            status: "promoted",
          },
        ],
        updatedAt: "2026-07-21T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );

    await expect(
      recoverSetupMigrationPromotion({
        stateDir,
        providerId: "claude",
        readConfigFile: async () => ({}),
      }),
    ).rejects.toThrow("published local data before config commit");

    expect(await fs.readFile(path.join(finalWorkspace, "MEMORY.md"), "utf8")).toBe("promoted\n");
    await expect(fs.access(stagedWorkspace)).rejects.toThrow();
    const journal = JSON.parse(
      await fs.readFile(path.join(reportDir, "onboarding-promotion.json"), "utf8"),
    ) as { status: string };
    expect(journal.status).toBe("indeterminate");
  });

  it("restores a pre-existing empty target when recovery starts before its rename", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const reportDir = path.join(stateDir, "migration", "claude", "2026-07-21T000000Z");
    const stagedRoot = path.join(root, "staged-root");
    const stagedWorkspace = path.join(stagedRoot, "workspace");
    const finalWorkspace = path.join(root, "workspace");
    await fs.mkdir(stagedWorkspace, { recursive: true });
    await fs.writeFile(path.join(stagedWorkspace, "MEMORY.md"), "staged\n", "utf8");
    await fs.mkdir(finalWorkspace, { recursive: true });
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(
      path.join(reportDir, "onboarding-promotion.json"),
      JSON.stringify({
        version: 1,
        status: "promoting",
        providerId: "claude",
        configHashBefore: configHash({}),
        configHashTarget: configHash({ gateway: { mode: "local" } }),
        components: [
          {
            name: "workspace",
            stagedPath: stagedWorkspace,
            finalPath: finalWorkspace,
            status: "staged",
            targetWasEmptyDirectory: true,
          },
        ],
        continuation: {
          ...continuation(),
          workspaceDir: finalWorkspace,
          stagedReportDir: path.join(stagedRoot, "report"),
          stagedRoots: [stagedRoot],
        },
        updatedAt: "2026-07-21T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );

    await recoverSetupMigrationPromotion({
      stateDir,
      providerId: "claude",
      readConfigFile: async () => ({}),
    });

    expect(await fs.readdir(finalWorkspace)).toEqual([]);
    await expect(fs.access(stagedRoot)).rejects.toThrow();
  });

  it("reconciles an interrupted promotion after config commit", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const reportDir = path.join(stateDir, "migration", "claude", "2026-07-21T000001Z");
    const finalWorkspace = path.join(root, "workspace");
    const targetConfig = { gateway: { mode: "local" as const } };
    await fs.mkdir(reportDir, { recursive: true });
    await fs.mkdir(finalWorkspace, { recursive: true });
    await fs.writeFile(
      path.join(reportDir, "onboarding-promotion.json"),
      JSON.stringify({
        version: 1,
        status: "promoting",
        providerId: "claude",
        configHashBefore: configHash({}),
        configHashTarget: configHash(targetConfig),
        components: [
          {
            name: "workspace",
            stagedPath: path.join(root, "staged-workspace"),
            finalPath: finalWorkspace,
            status: "promoted",
          },
        ],
        continuation: {
          ...continuation(),
          workspaceDir: finalWorkspace,
          stagedReportDir: path.join(root, "staged-report"),
          stagedRoots: [],
        },
        updatedAt: "2026-07-21T00:00:01.000Z",
      }),
      { mode: 0o600 },
    );

    const resume = await recoverSetupMigrationPromotion({
      stateDir,
      providerId: "claude",
      readConfigFile: async () => targetConfig,
    });

    expect(resume?.continuation.outcome).toEqual({ kind: "no-imported-inference" });
    const journal = JSON.parse(
      await fs.readFile(path.join(reportDir, "onboarding-promotion.json"), "utf8"),
    ) as { status: string };
    expect(journal.status).toBe("committed");
  });

  it("allows committed recovery after legitimate config changes", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const reportDir = path.join(stateDir, "migration", "claude", "2026-07-21T000002Z");
    const finalWorkspace = path.join(root, "workspace");
    const targetConfig = { gateway: { mode: "local" as const } };
    await fs.mkdir(reportDir, { recursive: true });
    await fs.mkdir(finalWorkspace, { recursive: true });
    await fs.writeFile(
      path.join(reportDir, "onboarding-promotion.json"),
      JSON.stringify({
        version: 1,
        status: "committed",
        providerId: "claude",
        configHashBefore: configHash({}),
        configHashTarget: configHash(targetConfig),
        components: [
          {
            name: "workspace",
            stagedPath: path.join(root, "staged-workspace"),
            finalPath: finalWorkspace,
            status: "promoted",
          },
        ],
        continuation: {
          ...continuation(),
          workspaceDir: finalWorkspace,
          stagedReportDir: path.join(root, "staged-report"),
          stagedRoots: [],
        },
        updatedAt: "2026-07-21T00:00:02.000Z",
      }),
      { mode: 0o600 },
    );

    await expect(
      recoverSetupMigrationPromotion({
        stateDir,
        providerId: "claude",
        readConfigFile: async () => ({ gateway: { port: 23456 } }),
      }),
    ).resolves.toBeDefined();
  });

  it("rejects committed recovery after the promoted target was reset", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const reportDir = path.join(stateDir, "migration", "claude", "2026-07-21T000002Z");
    const finalWorkspace = path.join(root, "workspace");
    const targetConfig = { gateway: { mode: "local" as const } };
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(
      path.join(reportDir, "onboarding-promotion.json"),
      JSON.stringify({
        version: 1,
        status: "committed",
        providerId: "claude",
        configHashBefore: configHash({}),
        configHashTarget: configHash(targetConfig),
        components: [
          {
            name: "workspace",
            stagedPath: path.join(root, "staged-workspace"),
            finalPath: finalWorkspace,
            status: "promoted",
          },
        ],
        continuation: {
          ...continuation(),
          workspaceDir: finalWorkspace,
          stagedReportDir: path.join(root, "staged-report"),
          stagedRoots: [],
        },
        updatedAt: "2026-07-21T00:00:02.000Z",
      }),
      { mode: 0o600 },
    );

    await expect(
      recoverSetupMigrationPromotion({
        stateDir,
        providerId: "claude",
        readConfigFile: async () => targetConfig,
      }),
    ).rejects.toThrow("no longer matches its promoted target");
  });

  it("reconciles a config writer that commits and then throws", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const reportDir = path.join(stateDir, "migration", "claude", "attempt");
    await fs.mkdir(path.join(stateDir, "migration"), { recursive: true });
    const targetConfig = { agents: { defaults: { workspace: workspaceDir } } };
    const stage = await createSetupMigrationStage({
      providerId: "claude",
      stateDir,
      workspaceDir,
      reportDir,
      targetConfig,
    });
    await fs.writeFile(path.join(stage.staged.workspaceDir, "MEMORY.md"), "staged\n", "utf8");
    let currentConfig: typeof targetConfig | Record<string, never> = {};

    const promoted = await stage.promote({
      expectedConfig: {},
      continuation: continuation(),
      readConfigFile: async () => structuredClone(currentConfig),
      commitConfigFile: async (config) => {
        currentConfig = structuredClone(config) as typeof targetConfig;
        throw new Error("write result lost");
      },
    });

    expect(promoted.config).toEqual(targetConfig);
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe("staged\n");
    const journal = JSON.parse(
      await fs.readFile(path.join(reportDir, "onboarding-promotion.json"), "utf8"),
    ) as { status: string };
    expect(journal.status).toBe("committed");
    await promoted.resume.complete();
    await fs.rm(workspaceDir, { recursive: true, force: true });
    const resumed = await recoverSetupMigrationPromotion({
      stateDir,
      providerId: "claude",
      readConfigFile: async () => ({ gateway: { mode: "local" } }),
    });
    expect(resumed?.continuation.outcome).toEqual({ kind: "no-imported-inference" });
    await resumed?.acknowledge();
    await expect(
      recoverSetupMigrationPromotion({
        stateDir,
        providerId: "claude",
        readConfigFile: async () => structuredClone(currentConfig),
      }),
    ).resolves.toBeUndefined();
    await stage.cleanup();
  });
});
