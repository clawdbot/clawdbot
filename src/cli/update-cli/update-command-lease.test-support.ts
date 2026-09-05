import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";

export type LeaseScenario = {
  lane: "resume" | "fresh-process" | "current-process" | "repair";
  pluginUpdate?: PostCorePluginUpdateResult;
  preDoctorChannel?: string;
  invalidConfig?: boolean;
  failDoctor?: "pre" | "post";
  readinessFailure?: "finding" | "execution";
  hostVersion?: string;
  writerConfig?: OpenClawConfig;
  writerRecords?: Record<string, PluginInstallRecord>;
};

// A narrow child substitutes for the CLI, not for its cross-process lease.
export async function runUpdateLeaseChild(): Promise<void> {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  assert.ok(stateDir && configPath);
  const scenario = JSON.parse(
    await fs.readFile(path.join(stateDir, "scenario.json"), "utf8"),
  ) as LeaseScenario;
  const record = async (event: string) =>
    fs.appendFile(
      path.join(stateDir, "events.jsonl"),
      `${JSON.stringify({ event, pid: process.pid })}\n`,
    );
  const publish = async () => {
    assert.ok(scenario.writerConfig && scenario.writerRecords);
    const { writePersistedInstalledPluginIndexInstallRecords } =
      await import("../../plugins/installed-plugin-index-records.js");
    await fs.writeFile(configPath, JSON.stringify(scenario.writerConfig));
    await writePersistedInstalledPluginIndexInstallRecords(scenario.writerRecords, {
      config: scenario.writerConfig,
    });
    await record("writer-committed");
  };
  const command = process.argv[2];
  if (command === "config") {
    assert.deepEqual(process.argv.slice(2), ["config", "validate", "--json"]);
    assert.equal(process.env.OPENCLAW_UPDATE_IN_PROGRESS, "0");
    await record("validate");
    process.exitCode = scenario.invalidConfig ? 1 : 0;
    return;
  }
  if (command === "doctor" && process.argv[3] === "--lint") {
    assert.deepEqual(process.argv.slice(3), ["--lint", "--json", "--severity-min", "error"]);
    assert.equal(process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE, "1");
    await record("readiness");
    if (scenario.readinessFailure === "execution") {
      throw new Error("readiness fixture failure");
    }
    const findings =
      scenario.readinessFailure === "finding"
        ? [
            {
              checkId: "fixture/post-plugin-readiness",
              severity: "error",
              source: "fixture",
              message: "Fixture plugin is not ready.",
              fixHint: "Run the fixture repair command.",
            },
          ]
        : [];
    process.stdout.write(
      `${JSON.stringify({
        ok: findings.length === 0,
        checksRun: 1,
        checksSkipped: 0,
        findings,
      })}\n`,
    );
    process.exitCode = findings.length === 0 ? 0 : 1;
    return;
  }
  const { withPluginLifecycleLease } = await import("../../plugins/plugin-lifecycle-lease.js");
  if (command === "update") {
    assert.equal(scenario.lane, "fresh-process");
    const resultPath = process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
    assert.ok(resultPath && scenario.pluginUpdate);
    await withPluginLifecycleLease({ waitMs: 0 }, async () => record("packages-acquired"));
    await record("packages-released");
    const { readConfigFileSnapshot } = await import("../../config/config.js");
    const { persistValidatedDowngradeConfig } = await import("./update-command-config.js");
    await persistValidatedDowngradeConfig(await readConfigFileSnapshot());
    await fs.writeFile(resultPath, JSON.stringify(scenario.pluginUpdate));
    return;
  }
  if (command === "doctor") {
    const phase = process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE === "1" ? "post" : "pre";
    assert.deepEqual(process.argv.slice(3), [
      "--repair",
      "--non-interactive",
      ...(scenario.lane === "repair" && phase === "pre" ? [] : ["--no-workspace-suggestions"]),
      "--yes",
    ]);
    assert.equal(process.env.OPENCLAW_UPDATE_IN_PROGRESS, "1");
    assert.equal(process.env.OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR, "1");
    assert.equal(process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE, "1");
    assert.equal(process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION, "0");
    assert.equal(process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR, "0");
    assert.equal(process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART, "1");
    if (scenario.hostVersion) {
      assert.equal(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION, scenario.hostVersion);
    }
    await record(`${phase}-attempt`);
    // One real acquisition attempt makes the regression fail promptly, without changing parent budgets.
    await withPluginLifecycleLease({ waitMs: 0 }, async () => {
      await record(`${phase}-acquired`);
      if (phase === "pre" && scenario.preDoctorChannel !== undefined) {
        const { readConfigFileSnapshot } = await import("../../config/config.js");
        assert.equal(
          (await readConfigFileSnapshot()).config.update?.channel,
          scenario.preDoctorChannel,
        );
      }
    });
    process.stdout.write("doctor fixture output\n");
    process.stderr.write("doctor fixture diagnostic\n");
    if (scenario.failDoctor === phase) {
      throw new Error("doctor fixture failure");
    }
    return;
  }
  if (command === "probe") {
    try {
      await withPluginLifecycleLease({ waitMs: 0 }, async () => record("probe-acquired"));
      process.stdout.write("acquired");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) {
        throw error;
      }
      assert.equal(error.code, "OPENCLAW_STATE_LEASE_TIMEOUT");
      process.stdout.write("excluded");
    }
    return;
  }
  assert.equal(command, "writer");
  assert.ok(process.connected, "writer requires an IPC channel");
  await withPluginLifecycleLease({}, async () => {
    const release = once(process, "message");
    process.send?.("acquired");
    await release;
    await publish();
  });
  process.disconnect?.();
}
