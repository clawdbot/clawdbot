// Covers the legacy-config copy gate: the preflight must not plant the canonical
// config out of an UNRESOLVED legacy state dir. A blocked run doing so would forge
// the initialized-state-root marker (state-migrations.state-dir.ts) and let the next
// boot checkpoint readiness while real data still sits in the legacy dir (#112395).
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";

type StateMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
};

const emptyStateMigration = async (): Promise<StateMigrationResult> => ({
  migrated: false,
  skipped: false,
  changes: [],
  warnings: [],
});

const autoMigrateLegacyStateDir = vi.hoisted(() => vi.fn());
const autoMigrateLegacyState = vi.hoisted(() => vi.fn());
const autoMigrateLegacyPluginDoctorState = vi.hoisted(() => vi.fn());
const autoMigrateLegacyTaskStateSidecars = vi.hoisted(() => vi.fn());
const migrateLegacyMediaPersistence = vi.hoisted(() =>
  vi.fn(() => ({ changes: [], warnings: [] })),
);
const repairLegacyCronStoreWithoutPrompt = vi.hoisted(() =>
  vi.fn(async () => ({ changes: [], warnings: [] })),
);
const collectCronCodexRuntimePolicyTargetsReadOnly = vi.hoisted(() =>
  vi.fn(async () => ({ targets: [], warnings: [] })),
);
const note = vi.hoisted(() => vi.fn());

vi.mock("./doctor-state-migrations.js", () => ({
  autoMigrateLegacyState,
  autoMigrateLegacyStateDir,
  autoMigrateLegacyPluginDoctorState,
  autoMigrateLegacyTaskStateSidecars,
  migrateLegacyMediaPersistence,
}));

vi.mock("./doctor/cron/legacy-repair.js", () => ({
  collectCronCodexRuntimePolicyTargetsReadOnly,
  repairLegacyCronStoreWithoutPrompt,
}));

const needsStateMigrationCheckpoint = vi.hoisted(() => vi.fn(() => false));
const needsStartupMigrationCheckpoint = vi.hoisted(() => vi.fn(() => false));
const startupMigrationLeaseRelease = vi.hoisted(() => vi.fn());
const startupMigrationLease = vi.hoisted(() => ({
  heartbeat: vi.fn(),
  owner: "legacy-config-test",
  release: startupMigrationLeaseRelease,
}));
// #120959 replaced the synchronous lease acquisition with a wait-for-concurrent-holder variant;
// this suite only exercises the single-process path, so the mock resolves immediately.
const acquireStartupMigrationLeaseWithWait = vi.hoisted(() =>
  vi.fn(async (_params: { env: NodeJS.ProcessEnv }) => startupMigrationLease),
);
const recordSuccessfulStateMigrations = vi.hoisted(() => vi.fn());
const recordSuccessfulStartupMigrations = vi.hoisted(() => vi.fn());

vi.mock("../infra/startup-migration-checkpoint.js", () => ({
  acquireStartupMigrationLeaseWithWait,
  needsStateMigrationCheckpoint,
  needsStartupMigrationCheckpoint,
  recordSuccessfulStateMigrations,
  recordSuccessfulStartupMigrations,
}));

vi.mock("../cli/update-cli/active-plugin-payload-validation.js", () => ({
  runActivePluginPayloadSmokeCheck: vi.fn(async () => ({ checked: [], failures: [] })),
}));

vi.mock("../cli/update-cli/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: vi.fn(async () => ({
    changes: [],
    notices: [],
    warnings: [],
    errored: false,
    smokeFailures: [],
    installRecords: {},
  })),
}));

vi.mock("./doctor/shared/startup-plugin-convergence-plan.js", () => ({
  planStartupPluginConvergence: vi.fn(async () => ({ required: false, installRecords: {} })),
}));

vi.mock("./doctor/shared/pristine-startup-state.js", () => ({
  planPristineStartupStateMigrations: vi.fn(() => ({
    skipAllStateMigrations: false,
    skipCoreStateMigrations: false,
  })),
}));

const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    exists: true,
    valid: true,
    config: { gateway: { mode: "local", port: 19091 } },
    sourceConfig: { gateway: { mode: "local", port: 19091 } },
    parsed: { gateway: { mode: "local", port: 19091 } },
    legacyIssues: [],
    warnings: [],
    issues: [],
  })),
);
// A stable non-null fingerprint across every read is required: runDoctorConfigPreflight
// compares the pre- and post-convergence checkpoint identity and refuses readiness
// (throwStartupMigrationIdentityChanged) when either side resolves to a null identity,
// which happens whenever the plugin migration fingerprint is missing.
const pluginMigrationFingerprint = vi.hoisted(() => vi.fn(() => "plugin-migrations"));
// Startup-checkpoint runs (requireStartupMigrationCheckpoint) read the config through this
// plugin-metadata-aware sibling instead of readConfigFileSnapshot; both must stay mocked so
// the checkpoint path in doctor-config-preflight.ts resolves a snapshot either way.
const readConfigFileSnapshotWithPluginMetadata = vi.hoisted(() =>
  vi.fn(async () => ({
    snapshot: await readConfigFileSnapshot(),
    pluginMetadataSnapshot: { configFingerprint: pluginMigrationFingerprint() },
  })),
);

vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");

async function withHomeFixture(run: (root: string) => Promise<void>): Promise<void> {
  const savedHome = process.env.HOME;
  const savedOpenClawHome = process.env.OPENCLAW_HOME;
  try {
    await withTestDir({ prefix: "openclaw-legacy-config-" }, async (root) => {
      process.env.HOME = root;
      process.env.OPENCLAW_HOME = root;
      await run(root);
    });
  } finally {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = savedOpenClawHome;
    }
  }
}

describe("runDoctorConfigPreflight legacy config migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks leaves implementations in place, so restore the checkpoint
    // default explicitly; a test that opts into checkpointing would otherwise
    // leak `true` into every case after it.
    needsStartupMigrationCheckpoint.mockReturnValue(false);
    // #120959 gates the state-dir migration behind its own needsStateMigrationCheckpoint
    // check, decoupled from needsStartupMigrationCheckpoint. Mirror it by default so this
    // suite's startup-checkpoint tests still reach autoMigrateLegacyStateDir.
    needsStateMigrationCheckpoint.mockImplementation(() => needsStartupMigrationCheckpoint());
    for (const mock of [
      autoMigrateLegacyStateDir,
      autoMigrateLegacyState,
      autoMigrateLegacyPluginDoctorState,
      autoMigrateLegacyTaskStateSidecars,
    ]) {
      mock.mockImplementation(emptyStateMigration);
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not plant the canonical config from an unresolved legacy state dir", async () => {
    await withHomeFixture(async (root) => {
      // A bare canonical root makes it the resolved state dir (config/paths.ts
      // resolveStateDir), so the copy target actually is ~/.openclaw and the
      // targetsDefaultStateRoot guard runs. Without it, resolveStateDir falls
      // through to the legacy dir itself and the guard is never reached.
      fs.mkdirSync(path.join(root, ".openclaw"), { recursive: true });
      const legacyDir = path.join(root, ".clawdbot");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "clawdbot.json"), "{}", "utf-8");
      fs.writeFileSync(path.join(legacyDir, "sessions.json"), "{}", "utf-8");

      await runDoctorConfigPreflight({ invalidConfigNote: false });

      expect(fs.existsSync(path.join(root, ".openclaw", "openclaw.json"))).toBe(false);
      expect(note).not.toHaveBeenCalledWith(
        expect.stringContaining("Migrated legacy config"),
        expect.anything(),
      );
    });
  });

  it("does not copy when the legacy symlink points somewhere other than the canonical root", async () => {
    await withHomeFixture(async (root) => {
      // Same reasoning as the unresolved-dir case above: a bare canonical root
      // is required so the copy target resolves to ~/.openclaw and the guard's
      // realpath comparison against the symlink target actually runs.
      fs.mkdirSync(path.join(root, ".openclaw"), { recursive: true });
      const elsewhere = path.join(root, "elsewhere");
      fs.mkdirSync(elsewhere, { recursive: true });
      fs.writeFileSync(path.join(elsewhere, "clawdbot.json"), "{}", "utf-8");
      const dirLinkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(elsewhere, path.join(root, ".clawdbot"), dirLinkType);

      await runDoctorConfigPreflight({ invalidConfigNote: false });

      expect(fs.existsSync(path.join(root, ".openclaw", "openclaw.json"))).toBe(false);
    });
  });

  it("copies the legacy config once the legacy dir is a resolved symlink", async () => {
    await withHomeFixture(async (root) => {
      const targetDir = path.join(root, ".openclaw");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "clawdbot.json"), "{}", "utf-8");
      const dirLinkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(targetDir, path.join(root, ".clawdbot"), dirLinkType);

      await runDoctorConfigPreflight({ invalidConfigNote: false });

      expect(fs.existsSync(path.join(targetDir, "openclaw.json"))).toBe(true);
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("Migrated legacy config"),
        "Doctor changes",
      );
    });
  });

  it("checkpoints readiness when the state-dir migration skips over an existing target (#112395)", async () => {
    needsStartupMigrationCheckpoint.mockReturnValue(true);
    const skipNotice =
      "State dir migration skipped: target already exists (/home/user/.openclaw). Remove or merge manually.";
    autoMigrateLegacyStateDir.mockResolvedValueOnce({
      migrated: false,
      skipped: false,
      changes: [],
      warnings: [],
      notices: [skipNotice],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
    });

    const pinnedEnv = acquireStartupMigrationLeaseWithWait.mock.calls[0]?.[0]?.env;
    expect(recordSuccessfulStartupMigrations).toHaveBeenCalledWith({
      env: pinnedEnv,
      identity: {
        effectiveConfigFingerprint: expect.any(String),
        pluginDoctorConfigFingerprint: expect.any(String),
        pluginMigrationFingerprint: "plugin-migrations",
      },
      lease: startupMigrationLease,
    });
    expect(note).toHaveBeenCalledWith(`- ${skipNotice}`, "Doctor notices");
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });
});
