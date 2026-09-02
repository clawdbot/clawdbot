import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { migrateLegacyWorkspaceState } from "./state-migrations.workspace-setup.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

describe("legacy workspace source precedence", () => {
  const { detect, setup } = useWorkspaceMigrationTestFixture();

  it("preserves the higher-priority setup source during legacy acceptance", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const rootPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    const nestedPath = path.join(context.workspaceDir, ".openclaw", "workspace-state.json");
    const rootSeededAt = "2026-07-16T00:00:00.000Z";
    const nestedSeededAt = "2026-07-14T00:00:00.000Z";
    await fsp.mkdir(path.dirname(nestedPath), { recursive: true });
    await fsp.writeFile(
      rootPath,
      JSON.stringify({ version: 1, bootstrapSeededAt: rootSeededAt }),
      "utf8",
    );
    await fsp.writeFile(
      nestedPath,
      JSON.stringify({ version: 1, bootstrapSeededAt: nestedSeededAt }),
      "utf8",
    );

    const result = await migrateLegacyWorkspaceState({
      detected: detect(context),
      env: context.env,
      stateDir: context.stateDir,
      acceptLegacyWorkspaceState: true,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Migrated workspace setup state to SQLite.");
    expect(fs.existsSync(rootPath)).toBe(false);
    expect(fs.existsSync(nestedPath)).toBe(false);
    expect(
      openOpenClawStateDatabase({ env: context.env })
        .db.prepare("SELECT bootstrap_seeded_at FROM workspace_setup_state WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toEqual({ bootstrap_seeded_at: rootSeededAt });
  });
});
