// Migration apply tests cover backups, filtering, provider apply calls, and report output.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";
import { createNonExitingRuntime } from "../../runtime.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { runMigrationApply } from "./apply.js";

let stateDir = "";
const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-migrate-apply-" });
const backupCreateCommandMock = vi.hoisted(() => vi.fn());

// The pre-migration backup runs the real archiver against real state, so the
// omission-reporting path is pinned at this boundary instead.
vi.mock("../backup.js", () => ({ backupCreateCommand: backupCreateCommandMock }));

vi.mock("../../config/paths.js", async (importActual) => {
  const actual = await importActual<typeof import("../../config/paths.js")>();
  return {
    ...actual,
    resolveGatewayPort: () => 18789,
    resolveStateDir: () => stateDir,
  };
});

function buildEmptyPlan(): MigrationPlan {
  return {
    providerId: "codex",
    source: "/tmp/codex",
    summary: {
      total: 0,
      planned: 0,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items: [],
  };
}

describe("runMigrationApply", () => {
  beforeAll(async () => {
    stateDir = await suiteTempDirs.setup();
  });

  afterAll(async () => {
    await suiteTempDirs.cleanup();
  });

  it("uses the resolved provider id when forwarding Codex options", async () => {
    const plan = vi.fn(async () => buildEmptyPlan());
    const apply = vi.fn(async () => buildEmptyPlan());
    const provider: MigrationProviderPlugin = {
      id: "codex",
      label: "Codex",
      plan,
      apply,
    };

    await runMigrationApply({
      runtime: createNonExitingRuntime(),
      opts: {
        yes: true,
        json: true,
        noBackup: true,
        configOverride: {},
        configPatchMode: "return",
        verifyPluginApps: true,
      },
      providerId: "codex",
      provider,
    });

    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          configPatchMode: "return",
          verifyPluginApps: true,
        },
      }),
    );
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          configPatchMode: "return",
          verifyPluginApps: true,
        },
      }),
      expect.anything(),
    );
  });

  it("returns partial item failures to embedded callers with report metadata", async () => {
    const partial = buildEmptyPlan();
    partial.summary = { ...partial.summary, total: 1, errors: 1 };
    partial.items = [
      {
        id: "memory:one",
        kind: "memory",
        action: "copy",
        status: "error",
        reason: "copy failed",
        details: { recoveryPath: "/tmp/staged-memory" },
      },
    ];
    const provider: MigrationProviderPlugin = {
      id: "codex",
      label: "Codex",
      plan: vi.fn(async () => buildEmptyPlan()),
      apply: vi.fn(async () => partial),
    };

    const result = await runMigrationApply({
      runtime: createNonExitingRuntime(),
      opts: {
        yes: true,
        json: true,
        noBackup: true,
        allowPartialResult: true,
      },
      providerId: "codex",
      provider,
    });

    expect(result.summary.errors).toBe(1);
    expect(result.items[0]?.details?.recoveryPath).toBe("/tmp/staged-memory");
    expect(result.reportDir).toContain("codex");
  });

  it("reports symbolic links the pre-migration backup omitted", async () => {
    backupCreateCommandMock.mockResolvedValue({
      archivePath: "/tmp/pre-migration.tar.gz",
      skippedSymbolicLinks: [
        { sourcePath: "/state/venv/bin/python3", linkTarget: "/usr/bin/python3" },
      ],
    });
    const provider: MigrationProviderPlugin = {
      id: "codex",
      label: "Codex",
      plan: vi.fn(async () => buildEmptyPlan()),
      apply: vi.fn(async () => buildEmptyPlan()),
    };
    const reported: string[] = [];
    const runtime = {
      ...createNonExitingRuntime(),
      error: (...args: unknown[]) => {
        reported.push(args.map(String).join(" "));
      },
    };

    await runMigrationApply({
      runtime,
      opts: { yes: true, json: true },
      providerId: "codex",
      provider,
    });

    expect(backupCreateCommandMock).toHaveBeenCalledOnce();
    // Without this the archive omits the link, the create summary is discarded,
    // and the migration proceeds with no record of the omission anywhere.
    expect(reported.join("\n")).toContain("omitted 1 symbolic link");
    expect(reported.join("\n")).toContain("/tmp/pre-migration.tar.gz");
    expect(reported).toContain("- /state/venv/bin/python3 -> /usr/bin/python3");
  });
});
