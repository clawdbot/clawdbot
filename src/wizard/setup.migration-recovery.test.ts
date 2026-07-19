import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createMigrationItem, summarizeMigrationItems } from "../plugin-sdk/migration.js";
import type { MigrationApplyResult, MigrationPlan } from "../plugins/types.js";
import {
  createSetupMigrationAttempt,
  prepareSetupMigrationRetryPlan,
  resolveSetupMigrationRecovery,
  runSetupMigrationAttempt,
  setupMigrationAttemptMatchesSource,
  setupMigrationProviderSupportsRecovery,
} from "./setup.migration-recovery.js";
import {
  buildSetupMigrationPlanSourceSnapshot,
  buildSetupMigrationTargetSnapshot,
} from "./setup.migration-snapshot.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const BEFORE_HASH = "a".repeat(64);
const AFTER_HASH = "b".repeat(64);
const CHANGED_HASH = "c".repeat(64);
const SOURCE_HASH = "d".repeat(64);

async function makeTempRoot(): Promise<string> {
  return tempRoots.make("openclaw-setup-recovery-");
}

function buildPlan(root: string): MigrationPlan {
  const items = [
    createMigrationItem({
      id: "config:mcp",
      kind: "config",
      action: "merge",
      status: "planned",
      target: "mcp.servers.safe",
      details: { path: ["mcp", "servers"], value: { safe: { command: "echo" } } },
    }),
    createMigrationItem({
      id: "workspace:SOUL.md",
      kind: "workspace",
      action: "copy",
      status: "planned",
      source: path.join(root, "hermes", "SOUL.md"),
      target: path.join(root, "workspace", "SOUL.md"),
    }),
    createMigrationItem({
      id: "workspace:AGENTS.md",
      kind: "workspace",
      action: "copy",
      status: "planned",
      source: path.join(root, "hermes", "AGENTS.md"),
      target: path.join(root, "workspace", "AGENTS.md"),
    }),
    createMigrationItem({
      id: "archive:state.db",
      kind: "archive",
      action: "archive",
      status: "planned",
      source: path.join(root, "hermes", "state.db"),
    }),
  ];
  return {
    providerId: "hermes",
    source: path.join(root, "hermes"),
    target: path.join(root, "workspace"),
    items,
    summary: summarizeMigrationItems(items),
  };
}

function buildFailedResult(plan: MigrationPlan): MigrationApplyResult {
  const items = [
    { ...plan.items[0]!, status: "migrated" as const },
    { ...plan.items[1]!, status: "error" as const, reason: "permission denied" },
    { ...plan.items[2]!, status: "skipped" as const, reason: "not attempted" },
    { ...plan.items[3]!, status: "migrated" as const },
  ];
  return { ...plan, items, summary: summarizeMigrationItems(items) };
}

async function persistFailedSetupMigrationAttempt(params: {
  reportDir: string;
  attempt: ReturnType<typeof createSetupMigrationAttempt>;
  targetSnapshotHash: string;
  result?: MigrationApplyResult;
}): Promise<void> {
  const failure = new Error("expected setup migration failure");
  await expect(
    runSetupMigrationAttempt({
      reportDir: params.reportDir,
      attempt: params.attempt,
      apply: async () => {
        if (!params.result) {
          throw failure;
        }
        return params.result;
      },
      assertSucceeded: () => {
        throw failure;
      },
      readTargetSnapshot: async () => params.targetSnapshotHash,
    }),
  ).rejects.toThrow(failure.message);
}

async function persistSucceededSetupMigrationAttempt(params: {
  reportDir: string;
  attempt: ReturnType<typeof createSetupMigrationAttempt>;
  result: MigrationApplyResult;
}): Promise<void> {
  await runSetupMigrationAttempt({
    reportDir: params.reportDir,
    attempt: params.attempt,
    apply: async () => params.result,
    assertSucceeded: () => {},
    readTargetSnapshot: async () => {
      throw new Error("successful migration should not read the failure snapshot");
    },
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("setup migration recovery", () => {
  it("limits recovery to the audited Hermes provider contract", () => {
    expect(setupMigrationProviderSupportsRecovery("hermes")).toBe(true);
    expect(setupMigrationProviderSupportsRecovery("other")).toBe(false);
  });

  it("retries only unchanged incomplete items against the exact failed target", async () => {
    const stateDir = await makeTempRoot();
    const identity = {
      providerId: "hermes",
      source: path.join(stateDir, "hermes"),
      workspaceDir: path.join(stateDir, "workspace"),
    };
    const plan = buildPlan(stateDir);
    const failed = createSetupMigrationAttempt(
      {
        ...identity,
        plan,
        sourceSnapshotHash: SOURCE_HASH,
        targetSnapshotHash: BEFORE_HASH,
      },
      new Date("2026-07-13T10:00:00Z"),
    );
    const failedReportDir = path.join(stateDir, "migration", "hermes", "2026-07-13T10-00-00Z");
    await persistFailedSetupMigrationAttempt({
      reportDir: failedReportDir,
      attempt: failed,
      result: buildFailedResult(plan),
      targetSnapshotHash: AFTER_HASH,
    });

    const recovery = await resolveSetupMigrationRecovery({
      stateDir,
      providerId: identity.providerId,
      workspaceDir: identity.workspaceDir,
      targetSnapshotHash: AFTER_HASH,
    });
    expect(recovery.kind).toBe("recoverable");
    if (recovery.kind !== "recoverable") {
      throw new Error("expected recoverable attempt");
    }
    await expect(
      resolveSetupMigrationRecovery({
        stateDir,
        providerId: identity.providerId,
        workspaceDir: identity.workspaceDir,
        targetSnapshotHash: CHANGED_HASH,
      }),
    ).resolves.toEqual({ kind: "none" });
    expect(setupMigrationAttemptMatchesSource(recovery.attempt, identity.source)).toBe(true);
    expect(
      setupMigrationAttemptMatchesSource(recovery.attempt, path.join(stateDir, "other-hermes")),
    ).toBe(false);

    const retryItems = [
      { ...plan.items[0]!, status: "conflict" as const, reason: "target exists" },
      plan.items[1]!,
      plan.items[2]!,
      plan.items[3]!,
    ];
    const retryPlan = { ...plan, items: retryItems, summary: summarizeMigrationItems(retryItems) };
    const prepared = prepareSetupMigrationRetryPlan(retryPlan, recovery.attempt, SOURCE_HASH);
    expect(prepared.items.map((item) => item.status)).toEqual([
      "skipped",
      "planned",
      "planned",
      "planned",
    ]);
    expect(prepared.items[0]?.reason).toContain("previous onboarding import attempt");

    const retry = createSetupMigrationAttempt({
      ...identity,
      plan: prepared,
      sourceSnapshotHash: SOURCE_HASH,
      targetSnapshotHash: AFTER_HASH,
      previousAttempt: recovery.attempt,
    });
    expect(retry.items.map((item) => item.resultStatus)).toEqual([
      "migrated",
      "error",
      "skipped",
      "migrated",
    ]);

    const retryResultItems = [
      prepared.items[0]!,
      { ...prepared.items[1]!, status: "error" as const, reason: "still denied" },
      { ...prepared.items[2]!, status: "skipped" as const, reason: "not attempted" },
      { ...prepared.items[3]!, status: "migrated" as const },
    ];
    await persistFailedSetupMigrationAttempt({
      reportDir: path.join(stateDir, "migration", "hermes", "2026-07-13T10-30-00Z"),
      attempt: retry,
      result: {
        ...prepared,
        items: retryResultItems,
        summary: summarizeMigrationItems(retryResultItems),
      },
      targetSnapshotHash: CHANGED_HASH,
    });
    const repeatedRecovery = await resolveSetupMigrationRecovery({
      stateDir,
      providerId: identity.providerId,
      workspaceDir: identity.workspaceDir,
      targetSnapshotHash: CHANGED_HASH,
    });
    expect(repeatedRecovery.kind).toBe("recoverable");
    if (repeatedRecovery.kind !== "recoverable") {
      throw new Error("expected repeated recovery attempt");
    }
    expect(
      prepareSetupMigrationRetryPlan(retryPlan, repeatedRecovery.attempt, SOURCE_HASH).items.map(
        (item) => item.status,
      ),
    ).toEqual(["skipped", "planned", "planned", "planned"]);

    const changedItems = [
      plan.items[0]!,
      { ...plan.items[1]!, target: path.join(stateDir, "other-workspace", "SOUL.md") },
    ];
    expect(() =>
      prepareSetupMigrationRetryPlan(
        { ...plan, items: changedItems, summary: summarizeMigrationItems(changedItems) },
        recovery.attempt,
        SOURCE_HASH,
      ),
    ).toThrow("Migration retry plan changed");
    expect(() => prepareSetupMigrationRetryPlan(retryPlan, recovery.attempt, CHANGED_HASH)).toThrow(
      "Migration source changed",
    );
    expect(() =>
      prepareSetupMigrationRetryPlan(
        { ...retryPlan, metadata: { changed: true } },
        recovery.attempt,
        SOURCE_HASH,
      ),
    ).toThrow("Migration retry plan context changed");

    const succeeded = createSetupMigrationAttempt({
      ...identity,
      plan: prepared,
      sourceSnapshotHash: SOURCE_HASH,
      targetSnapshotHash: AFTER_HASH,
      previousAttempt: recovery.attempt,
    });
    await persistSucceededSetupMigrationAttempt({
      reportDir: path.join(stateDir, "migration", "hermes", "2026-07-13T11-00-00Z"),
      attempt: succeeded,
      result: buildFailedResult(prepared),
    });
    await expect(
      resolveSetupMigrationRecovery({
        stateDir,
        providerId: identity.providerId,
        workspaceDir: identity.workspaceDir,
        targetSnapshotHash: AFTER_HASH,
      }),
    ).resolves.toEqual({ kind: "none" });

    const persisted = await fs.readFile(
      path.join(failedReportDir, "onboarding-attempt.json"),
      "utf8",
    );
    expect(persisted).not.toContain(identity.source);
    expect(persisted).not.toContain(identity.workspaceDir);
  });

  it("recovers an interrupted applying attempt only before target side effects", async () => {
    const stateDir = await makeTempRoot();
    const identity = {
      providerId: "hermes",
      source: path.join(stateDir, "hermes"),
      workspaceDir: path.join(stateDir, "workspace"),
    };
    const plan = buildPlan(stateDir);
    const attempt = createSetupMigrationAttempt({
      ...identity,
      plan,
      sourceSnapshotHash: SOURCE_HASH,
      preparedTargetSnapshotHash: BEFORE_HASH,
      targetSnapshotHash: AFTER_HASH,
    });
    const applyingReportDir = path.join(stateDir, "migration", "hermes", "2026-07-13T10-00-00Z");
    const apply = createDeferred<MigrationApplyResult>();
    const applyingRun = runSetupMigrationAttempt({
      reportDir: applyingReportDir,
      attempt,
      apply: async () => await apply.promise,
      assertSucceeded: () => {},
      readTargetSnapshot: async () => {
        throw new Error("pending migration should not read the failure snapshot");
      },
    });
    await vi.waitFor(async () => {
      await expect(
        fs.readFile(path.join(applyingReportDir, "onboarding-attempt.json"), "utf8"),
      ).resolves.toContain('"status": "applying"');
    });

    await expect(
      resolveSetupMigrationRecovery({
        stateDir,
        providerId: identity.providerId,
        workspaceDir: identity.workspaceDir,
        targetSnapshotHash: BEFORE_HASH,
      }),
    ).resolves.toMatchObject({ kind: "recoverable" });
    await expect(
      resolveSetupMigrationRecovery({
        stateDir,
        providerId: identity.providerId,
        workspaceDir: identity.workspaceDir,
        targetSnapshotHash: AFTER_HASH,
      }),
    ).resolves.toMatchObject({ kind: "recoverable" });
    await expect(
      resolveSetupMigrationRecovery({
        stateDir,
        providerId: identity.providerId,
        workspaceDir: identity.workspaceDir,
        targetSnapshotHash: CHANGED_HASH,
      }),
    ).resolves.toEqual({ kind: "none" });

    apply.resolve(buildFailedResult(plan));
    await applyingRun;

    const failedReportDir = path.join(stateDir, "migration", "hermes", "2026-07-13T11-00-00Z");
    await persistFailedSetupMigrationAttempt({
      reportDir: failedReportDir,
      attempt,
      targetSnapshotHash: BEFORE_HASH,
    });
    await expect(
      resolveSetupMigrationRecovery({
        stateDir,
        providerId: identity.providerId,
        workspaceDir: identity.workspaceDir,
        targetSnapshotHash: BEFORE_HASH,
      }),
    ).resolves.toMatchObject({ kind: "recoverable" });

    await persistFailedSetupMigrationAttempt({
      reportDir: failedReportDir,
      attempt,
      targetSnapshotHash: CHANGED_HASH,
    });
    await expect(
      resolveSetupMigrationRecovery({
        stateDir,
        providerId: identity.providerId,
        workspaceDir: identity.workspaceDir,
        targetSnapshotHash: CHANGED_HASH,
      }),
    ).resolves.toEqual({ kind: "none" });
  });

  it("binds retries to the planned source contents", async () => {
    const root = await makeTempRoot();
    const sourceDir = path.join(root, "hermes");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "SOUL.md"), "Original soul.\n");
    await fs.writeFile(path.join(sourceDir, "AGENTS.md"), "Original agents.\n");
    const plan = buildPlan(root);
    const initial = await buildSetupMigrationPlanSourceSnapshot(plan);

    await fs.writeFile(path.join(sourceDir, "SOUL.md"), "Changed soul.\n");
    await expect(buildSetupMigrationPlanSourceSnapshot(plan)).resolves.not.toBe(initial);

    const databasePath = path.join(sourceDir, "state.db");
    await fs.writeFile(databasePath, "database");
    const databaseItems = [
      createMigrationItem({
        id: "archive:state.db",
        kind: "archive",
        action: "archive",
        source: databasePath,
      }),
    ];
    const databasePlan = {
      ...plan,
      items: databaseItems,
      summary: summarizeMigrationItems(databaseItems),
    };
    const databaseInitial = await buildSetupMigrationPlanSourceSnapshot(databasePlan);
    await fs.writeFile(`${databasePath}-wal`, "committed rows");
    await expect(buildSetupMigrationPlanSourceSnapshot(databasePlan)).resolves.not.toBe(
      databaseInitial,
    );
  });

  it.skipIf(process.platform === "win32")("hashes source symlink referent contents", async () => {
    const root = await makeTempRoot();
    const sourceDir = path.join(root, "hermes");
    await fs.mkdir(sourceDir, { recursive: true });
    const referent = path.join(sourceDir, "soul-source.md");
    await fs.writeFile(referent, "Original soul.\n");
    await fs.symlink(path.basename(referent), path.join(sourceDir, "SOUL.md"));
    const initial = await buildSetupMigrationPlanSourceSnapshot(buildPlan(root));

    await fs.writeFile(referent, "Changed soul.\n");
    await expect(buildSetupMigrationPlanSourceSnapshot(buildPlan(root))).resolves.not.toBe(initial);
  });

  it("treats source paths beneath a non-directory as missing", async () => {
    const root = await makeTempRoot();
    const plan = buildPlan(root);
    const missingSnapshot = await buildSetupMigrationPlanSourceSnapshot(plan);
    await fs.writeFile(path.join(root, "hermes"), "not a directory");

    await expect(buildSetupMigrationPlanSourceSnapshot(plan)).resolves.toBe(missingSnapshot);
  });

  it("snapshots meaningful target changes but ignores migration reports", async () => {
    const stateDir = await makeTempRoot();
    const workspaceDir = path.join(stateDir, "workspace");
    const initial = await buildSetupMigrationTargetSnapshot({
      config: {},
      stateDir,
      workspaceDir,
    });

    await fs.mkdir(path.join(stateDir, "migration", "hermes", "report"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "migration", "hermes", "report", "result.json"), "{}");
    await expect(
      buildSetupMigrationTargetSnapshot({ config: {}, stateDir, workspaceDir }),
    ).resolves.toBe(initial);
    await expect(
      buildSetupMigrationTargetSnapshot({
        config: { meta: { lastTouchedAt: "2026-07-13T23:00:00.000Z" } },
        stateDir,
        workspaceDir,
      }),
    ).resolves.toBe(initial);
    await expect(
      buildSetupMigrationTargetSnapshot({
        config: { wizard: { securityAcknowledgedAt: "2026-07-13T23:00:00.000Z" } },
        stateDir,
        workspaceDir,
      }),
    ).resolves.toBe(initial);
    await expect(
      buildSetupMigrationTargetSnapshot({
        config: {
          wizard: {
            securityAcknowledgedAt: "2026-07-13T23:00:00.000Z",
            lastRunCommand: "onboard",
          },
        },
        stateDir,
        workspaceDir,
      }),
    ).resolves.not.toBe(initial);

    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Be useful.\n");
    const workspaceChanged = await buildSetupMigrationTargetSnapshot({
      config: {},
      stateDir,
      workspaceDir,
    });
    expect(workspaceChanged).not.toBe(initial);
    await expect(
      buildSetupMigrationTargetSnapshot({
        config: { agents: { defaults: { workspace: workspaceDir } } },
        stateDir,
        workspaceDir,
      }),
    ).resolves.not.toBe(workspaceChanged);
  });

  it("treats target paths beneath a non-directory as missing", async () => {
    const stateDir = await makeTempRoot();
    const workspaceDir = path.join(stateDir, "workspace");
    const missingSnapshot = await buildSetupMigrationTargetSnapshot({
      config: {},
      stateDir,
      workspaceDir,
    });
    await fs.writeFile(workspaceDir, "not a directory");

    await expect(
      buildSetupMigrationTargetSnapshot({ config: {}, stateDir, workspaceDir }),
    ).resolves.toBe(missingSnapshot);
  });

  it("fails closed when the newest recovery record is malformed", async () => {
    const stateDir = await makeTempRoot();
    const reportDir = path.join(stateDir, "migration", "hermes", "2026-07-13T10-00-00Z");
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(path.join(reportDir, "onboarding-attempt.json"), "{}\n", "utf8");

    await expect(
      resolveSetupMigrationRecovery({
        stateDir,
        providerId: "hermes",
        workspaceDir: path.join(stateDir, "workspace"),
        targetSnapshotHash: BEFORE_HASH,
      }),
    ).rejects.toThrow("Invalid onboarding migration recovery record");
  });

  it("treats a not-directory migration root as no recovery record", async () => {
    // A file at the provider report path makes readdir return ENOTDIR; recovery
    // treats that unavailable child path like a missing report directory.
    const stateDir = await makeTempRoot();
    await fs.mkdir(path.join(stateDir, "migration"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "migration", "hermes"), "not a directory");

    await expect(
      resolveSetupMigrationRecovery({
        stateDir,
        providerId: "hermes",
        workspaceDir: path.join(stateDir, "workspace"),
        targetSnapshotHash: BEFORE_HASH,
      }),
    ).resolves.toEqual({ kind: "none" });
  });
});
