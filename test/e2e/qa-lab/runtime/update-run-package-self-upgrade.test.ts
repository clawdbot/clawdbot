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
  });

  it("formats the proven version transition and sentinel", () => {
    expect(
      formatUpdateRunSelfUpgradeDetails({
        installedVersion: "2026.7.2",
        source: { version: "2026.4.26" },
        target: { resolvedVersion: "2026.7.2", tag: "latest" },
        restartSentinel: {
          message: "QA-UPDATE-RUN-PACKAGE-SELF-UPGRADE",
          status: "ok",
        },
      }),
    ).toBe(
      "source=2026.4.26; target=latest:2026.7.2; installed=2026.7.2; sentinel=ok:QA-UPDATE-RUN-PACKAGE-SELF-UPGRADE",
    );
  });
});
