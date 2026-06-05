// Migration apply tests cover backups, filtering, provider apply calls, and report output.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";
import { createNonExitingRuntime } from "../../runtime.js";
import { runMigrationApply } from "./apply.js";

const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-migrate-apply-"));

vi.mock("../../config/paths.js", () => ({
  resolveStateDir: () => stateDir,
}));

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
});
