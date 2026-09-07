// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  writeExecApprovalsConfigRow,
} from "../infra/exec-approvals-sqlite.js";
import {
  detectLegacyExecApprovals,
  migrateLegacyExecApprovals,
} from "../infra/state-migrations.exec-approvals.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

it("reports unsupported workspace and conflicting exec policy without recommending itself", async () => {
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.outro.mockClear();
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true, workspace: state.workspaceDir } } },
    };
    mocks.config.mockReturnValue(cfg);
    const identity = resolveWorkspaceStateIdentity(state.workspaceDir);
    const { db, path: databasePath } = openOpenClawStateDatabase({ env: state.env });
    db.prepare(
      "INSERT INTO workspace_setup_state (workspace_key, workspace_path, version, updated_at) VALUES (?, ?, 99, 1)",
    ).run(identity.workspaceKey, identity.workspacePath);
    writeExecApprovalsConfigRow({
      db,
      file: { version: 1, defaults: { security: "deny" }, agents: {} },
    });
    const canonical = readExecApprovalsConfigRow(db);
    const legacy = serializeExecApprovals({
      version: 1,
      defaults: { security: "full" },
      agents: {},
    });
    const sourcePath = state.statePath("exec-approvals.json");
    fs.writeFileSync(sourcePath, legacy);
    mocks.runContributions.mockImplementation(async (ctx) => {
      const result = await migrateLegacyExecApprovals({
        stateDir: state.stateDir,
        env: state.env,
        detected: detectLegacyExecApprovals({
          stateDir: state.stateDir,
          doctorOnlyStateMigrations: true,
        }),
      });
      ctx.runtime.log(result.warnings.join("\n"));
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await runCommandWithRuntime(runtime, () =>
      runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
    );
    const output = [...runtime.log.mock.calls, ...runtime.error.mock.calls].flat().join("\n");
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(output).toContain(databasePath);
    expect(output).toContain(state.workspaceDir);
    expect(output).toContain("99");
    expect(output).toContain("compatible OpenClaw build");
    expect(output).toContain(sourcePath);
    expect(output).toContain("reconcile this file");
    expect(output).not.toMatch(/(?:openclaw\s+)?doctor\s+--(?:fix|repair)/i);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(legacy);
    const reopened = openOpenClawStateDatabase({ env: state.env }).db;
    expect(readExecApprovalsConfigRow(reopened)).toEqual(canonical);
    expect(
      reopened
        .prepare("SELECT version FROM workspace_setup_state WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toEqual({ version: 99 });
    expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
  });
});
