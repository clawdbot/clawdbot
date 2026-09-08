import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectRepointedWorkspaceAlias,
  rebindRepointedWorkspaceAlias,
} from "../agents/workspace-alias-rebind.js";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { readReceipt } from "./state-migrations.workspace-setup-receipts.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

describe("Doctor workspace move ordering", () => {
  const { setup, detect, migrate } = useWorkspaceMigrationTestFixture();

  it("repairs the workspace owner before importing a carried legacy setup generation", async () => {
    const context = setup();
    const alias = path.join(context.homeDir, "workspace-alias");
    const moved = path.join(context.homeDir, "moved-workspace");
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(context.workspaceDir, alias, symlinkType);
    const configured = {
      ...context,
      cfg: {
        agents: { entries: { main: { workspace: alias } } },
        plugins: { enabled: false },
      },
      workspaceDir: alias,
    };
    const milestones = {
      version: 1,
      bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
      setupCompletedAt: "2026-07-15T10:01:00.000Z",
    };
    const raw = JSON.stringify(milestones);
    const sourceName = "openclaw-workspace-state.json";
    fs.writeFileSync(path.join(context.workspaceDir, sourceName), raw);
    const source = detect(configured).sources.find((entry) => entry.kind === "setup")!;
    expect((await migrate(configured)).warnings).toEqual([]);
    expect(readReceipt(source, context.env)?.removedSource).toBe(true);

    fs.renameSync(context.workspaceDir, moved);
    fs.unlinkSync(alias);
    fs.symlinkSync(moved, alias, symlinkType);
    const carriedSource = path.join(moved, sourceName);
    fs.writeFileSync(carriedSource, raw);

    try {
      const result = await autoMigrateLegacyState({
        cfg: configured.cfg,
        env: context.env,
        homedir: () => context.homeDir,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        beforeWorkspaceStateMigration: async () => {
          const facts = detectRepointedWorkspaceAlias(alias, { env: context.env })!;
          expect(await rebindRepointedWorkspaceAlias(alias, facts, { env: context.env })).toBe(
            "rebound",
          );
        },
      });

      expect(result.warnings).toEqual([]);
      expect(fs.existsSync(carriedSource)).toBe(false);
      expect(fs.existsSync(`${carriedSource}.doctor-importing`)).toBe(false);
      const identity = resolveWorkspaceStateIdentity(moved);
      expect(readWorkspaceStateSnapshot(alias, { env: context.env })).toMatchObject({
        identity,
        setup: milestones,
      });
      expect(
        readReceipt(
          {
            ...source,
            sourcePath: path.join(identity.workspacePath, sourceName),
            workspaceDir: identity.workspacePath,
            workspaceKey: identity.workspaceKey,
          },
          context.env,
        )?.removedSource,
      ).toBe(true);
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });
});
