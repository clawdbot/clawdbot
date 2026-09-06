import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatUpdateRunSelfUpgradeDetails,
  parseUpdateRunSelfUpgradeOptions,
  resolveUpdateRunSelfUpgradePermission,
} from "./update-run-package-self-upgrade.js";

describe("update.run package self-upgrade producer", () => {
  it("requires an explicit destructive opt-in", () => {
    expect(resolveUpdateRunSelfUpgradePermission({})).toEqual({
      allowed: false,
      reason:
        "blocked destructive package self-upgrade; set OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF=1 to run",
    });
    expect(
      resolveUpdateRunSelfUpgradePermission({ OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF: "1" }),
    ).toEqual({ allowed: true });
  });

  it("parses the evidence artifact directory", () => {
    expect(
      parseUpdateRunSelfUpgradeOptions(["--artifact-base", ".artifacts/update-run"]).artifactBase,
    ).toContain(".artifacts/update-run");
    expect(() => parseUpdateRunSelfUpgradeOptions([])).toThrow("--artifact-base is required");
  });

  it("uses one supervised update handoff without a manual target restart", async () => {
    const script = await fs.readFile(
      path.join(
        process.cwd(),
        "scripts/e2e/lib/upgrade-survivor/update-run-package-self-upgrade.sh",
      ),
      "utf8",
    );

    expect(script).toContain("source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh");
    expect(script).toContain("-u OPENCLAW_SKIP_PROVIDERS");
    expect(script).toContain("systemctl --user start openclaw-gateway.service");
    expect(script).toContain("OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service");
    expect(script).toContain("restart mode: update process respawn (supervisor restart)");
    expect(script).toContain("service-owned target environment unexpectedly suppresses providers");
    expect(script).not.toContain("target_gateway_pid");
    expect(script).not.toContain("openclaw_e2e_stop_process");
    expect(script).toContain("systemctl --user stop openclaw-gateway.service");
    expect(script).toContain(': >"$SYSTEMCTL_SHIM_LOG"');
    const runCleanup = script.slice(
      script.indexOf("rm -f \\"),
      script.indexOf(': >"$SYSTEMCTL_SHIM_DAEMON_LOG"'),
    );
    expect(runCleanup).toContain('"$UPDATE_STATUS_JSON"');
    expect(runCleanup).toContain('"$ARTIFACT_DIR/update-status.candidate.json"');
    expect(script.indexOf("openclaw gateway install --force --json")).toBeLessThan(
      script.indexOf("OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service"),
    );
  });

  it("gives update.run matching server and CLI timeout budgets", async () => {
    const script = await fs.readFile(
      path.join(
        process.cwd(),
        "scripts/e2e/lib/upgrade-survivor/update-run-package-self-upgrade.sh",
      ),
      "utf8",
    );

    expect(script).toContain('local timeout_ms="${5:-30000}"');
    expect(script).toContain('--timeout "$timeout_ms"');
    expect(script).toContain(
      'gateway_call update.run "$update_params" "$UPDATE_RPC_JSON" "$UPDATE_RPC_ERR" 1200000',
    );
  });

  it("proves the authenticated setup lifecycle before updating", async () => {
    const script = await fs.readFile(
      path.join(
        process.cwd(),
        "scripts/e2e/lib/upgrade-survivor/update-run-package-self-upgrade.sh",
      ),
      "utf8",
    );

    expect(script).toContain(
      'gateway_call wizard.start \'{"mode":"local"}\' "$WIZARD_START_JSON" "$WIZARD_START_ERR"',
    );
    expect(script).toContain(
      'gateway_call wizard.status "$wizard_session_params" "$WIZARD_STATUS_JSON" "$WIZARD_STATUS_ERR"',
    );
    expect(script).toContain(
      'gateway_call wizard.next "$wizard_next_params" "$WIZARD_NEXT_JSON" "$WIZARD_NEXT_ERR"',
    );
    expect(script).toContain("runningStatusRetained: true");
    expect(script).toContain("assert_gateway_call_error_message()");
    expect(script).toContain(
      '"$WIZARD_DUPLICATE_JSON" \\\n  "$WIZARD_DUPLICATE_ERR" \\\n  "wizard already running"',
    );
    expect(script).toContain('local allow_stderr_fallback="${5:-0}"');
    expect(script).toContain(
      '[ "$allow_stderr_fallback" = "1" ] && grep -Fq "$expected" "$error_output"',
    );
    expect(script).toContain(
      'gateway_call wizard.cancel "$wizard_session_params" "$WIZARD_CANCEL_JSON" "$WIZARD_CANCEL_ERR"',
    );
    expect(script).toContain(
      '"$WIZARD_CANCELLED_STATUS_JSON" \\\n  "$WIZARD_CANCELLED_STATUS_ERR" \\\n  "wizard not found"',
    );
    expect(script).toContain('step.sensitive === true && Object.hasOwn(step, "initialValue")');
    expect(script.indexOf("Exercising authenticated Gateway wizard RPC lifecycle")).toBeLessThan(
      script.indexOf("Invoking authenticated Gateway RPC update.run"),
    );
  });

  it("proves the current target setup lifecycle after updating", async () => {
    const script = await fs.readFile(
      path.join(
        process.cwd(),
        "scripts/e2e/lib/upgrade-survivor/update-run-package-self-upgrade.sh",
      ),
      "utf8",
    );

    expect(script).toContain("Exercising current target Gateway wizard RPC lifecycle");
    expect(script).toContain(
      'gateway_call wizard.status "$target_status_session_params" \\\n  "$TARGET_WIZARD_STATUS_JSON" "$TARGET_WIZARD_STATUS_ERR"',
    );
    expect(script).toContain(
      'gateway_call wizard.status "$target_status_session_params" \\\n  "$TARGET_WIZARD_STATUS_RETAINED_JSON" "$TARGET_WIZARD_STATUS_RETAINED_ERR"',
    );
    expect(script).toContain(
      'gateway_call wizard.cancel "$target_status_session_params" \\\n  "$TARGET_WIZARD_STATUS_CANCEL_JSON" "$TARGET_WIZARD_STATUS_CANCEL_ERR"',
    );
    expect(script).toContain(
      'gateway_call wizard.next "$target_active_next_params" \\\n  "$TARGET_WIZARD_NEXT_JSON" "$TARGET_WIZARD_NEXT_ERR"',
    );
    expect(script).toContain(
      'gateway_call wizard.cancel "$target_active_session_params" \\\n  "$TARGET_WIZARD_CANCEL_JSON" "$TARGET_WIZARD_CANCEL_ERR"',
    );
    expect(script).toContain("wait_for_target_wizard_start()");
    expect(script).toContain("target_status_settlement_polls");
    expect(script).toContain("target_cancel_settlement_polls");
    expect(script).toContain(
      '"$TARGET_WIZARD_REPLACEMENT_START_JSON" \\\n    "$TARGET_WIZARD_REPLACEMENT_START_ERR"',
    );
    expect(script.indexOf("target_active_start_result=")).toBeLessThan(
      script.indexOf(
        'gateway_call wizard.status "$target_status_session_params" \\\n  "$TARGET_WIZARD_STATUS_PURGED_JSON"',
      ),
    );
    expect(script).toContain(
      '"$TARGET_WIZARD_PURGED_STATUS_JSON" \\\n  "$TARGET_WIZARD_PURGED_STATUS_ERR" \\\n  "wizard not found"',
    );
    expect(script.indexOf("target_replacement_start_result=")).toBeLessThan(
      script.indexOf(
        'gateway_call wizard.status "$target_active_session_params" \\\n  "$TARGET_WIZARD_PURGED_STATUS_JSON"',
      ),
    );
    expect(script.indexOf("Invoking authenticated Gateway RPC update.run")).toBeLessThan(
      script.indexOf("Exercising current target Gateway wizard RPC lifecycle"),
    );
    expect(script.indexOf("Exercising current target Gateway wizard RPC lifecycle")).toBeLessThan(
      script.indexOf("post_restart_observed_at_ms="),
    );
  });

  it("falls back to the exact tag clone when commit or tag objects are missing", async () => {
    const script = await fs.readFile(
      path.join(process.cwd(), "scripts/e2e/update-run-package-self-upgrade-docker.sh"),
      "utf8",
    );

    expect(script).toContain(
      'if ! git -C "$source_repo" cat-file -e "$SOURCE_COMMIT^{commit}" 2>/dev/null ||',
    );
    expect(script).toContain(
      '! git -C "$source_repo" cat-file -e "$SOURCE_TAG^{commit}" 2>/dev/null',
    );
    expect(script).toContain('tar -C "$checkout_root" -cf "$HISTORICAL_DIST_ARCHIVE" dist');
    expect(script).toContain(
      'npm install \\\n  --prefix "$historical_install_root" \\\n  --omit=dev',
    );
    expect(script).toContain(
      'tar --no-same-owner \\\n  -xf /tmp/openclaw-update-run-historical-dist.tar \\\n  -C "$historical_package_root"',
    );
    expect(script).toContain(
      'ln -s "$historical_package_root/dist/extensions/qa-channel" "$qa_plugin_link"',
    );
    expect(script).toContain("await import(pathToFileURL(pluginEntry).href)");
    expect(script).not.toContain(
      '-v "$QA_CHANNEL_FIXTURE_ROOT/checkout:/tmp/openclaw-update-run-build:ro"',
    );
    expect(script).not.toContain("NODE_PATH");
  });

  it("formats the proven version transition and sentinel", () => {
    expect(
      formatUpdateRunSelfUpgradeDetails({
        installedVersion: "2026.7.2",
        source: { version: "2026.4.26" },
        target: { resolvedVersion: "2026.7.2", tag: "latest" },
        wizardFlow: {
          authenticated: true,
          cancelledSessionPurged: true,
          duplicateStartRejected: true,
          runningStatusRetained: true,
          status: "passed",
        },
        targetWizardFlow: {
          activeSession: {
            duplicateStartRejected: true,
            purged: true,
          },
          authenticated: true,
          status: "passed",
          statusSession: {
            purged: true,
            runningStatusRetained: true,
          },
        },
        restartSentinel: {
          message: "QA-UPDATE-RUN-PACKAGE-SELF-UPGRADE",
          status: "ok",
        },
      }),
    ).toBe(
      "wizard=passed:authenticated:status-retained:exclusive:purged; target-wizard=passed:authenticated:status-retained:status-purged:exclusive:purged; source=2026.4.26; target=latest:2026.7.2; installed=2026.7.2; sentinel=ok:QA-UPDATE-RUN-PACKAGE-SELF-UPGRADE",
    );
  });
});
