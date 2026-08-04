// Verifies pending Control UI device-auth migrations remain visible to security audits.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeControlUiDeviceAuthMigration,
  importPendingControlUiDeviceAuthMigration,
} from "../state/control-ui-device-auth-migration.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runSecurityAudit } from "./audit.js";

const stateDirs: string[] = [];

function createStateEnv(): { stateDir: string; env: NodeJS.ProcessEnv } {
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-audit-device-auth-migration-"));
  stateDirs.push(stateDir);
  return { stateDir, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

async function collectMigrationFinding(params: { stateDir: string; env: NodeJS.ProcessEnv }) {
  const report = await runSecurityAudit({
    config: {},
    env: params.env,
    stateDir: params.stateDir,
    includeFilesystem: false,
    includeChannelSecurity: false,
    loadPluginSecurityCollectors: false,
  });
  return report.findings.find(
    (finding) => finding.checkId === "gateway.control_ui.device_auth_disabled",
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("security audit Control UI device-auth migration", () => {
  it("reports the pending compatibility window as a critical downgrade", async () => {
    const options = createStateEnv();
    importPendingControlUiDeviceAuthMigration({ env: options.env });

    const finding = await collectMigrationFinding(options);

    expect(finding).toMatchObject({
      severity: "critical",
      title: "Control UI device-auth migration is pending",
    });
  });

  it("clears the finding after pairing completes", async () => {
    const options = createStateEnv();
    importPendingControlUiDeviceAuthMigration({ env: options.env });
    completeControlUiDeviceAuthMigration("browser-1", { env: options.env });

    await expect(collectMigrationFinding(options)).resolves.toBeUndefined();
  });

  it("does not report a migration that was never required", async () => {
    const options = createStateEnv();

    await expect(collectMigrationFinding(options)).resolves.toBeUndefined();
  });
});
