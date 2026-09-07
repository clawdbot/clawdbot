import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseAgentTurnArgs } from "./agent.ts";
import type {
  CandidateBuild,
  GatewayHandle,
  LaneBaseParams,
  LaneResult,
  LaneState,
} from "./config.ts";
import { buildPackagedUpgradeUpdateArgs, buildRealUpdateEnv, updateTimeoutMs } from "./config.ts";
import { readInstalledMetadata, verifyInstalledCandidate } from "./install.ts";
import { installLaneCompanions } from "./lane-companions.ts";
import { hasChildExited, reserveGatewayPortForLane, runCommand, stopGateway } from "./process.ts";
import { runTimedLanePhase } from "./reporting.ts";
import {
  runDashboardSmoke,
  runModelsSet,
  runOnboard,
  runOpenClaw,
  startGateway,
  waitForGateway,
} from "./runtime.ts";

// Preserve a real baseline conversation across the published updater's migration.
export async function runPackagedSelfUpdateTransition(
  params: LaneBaseParams & {
    lane: LaneState;
    env: NodeJS.ProcessEnv;
    build: CandidateBuild;
    candidateUrl: string;
    baselineVersion: string;
  },
): Promise<LaneResult> {
  const { lane, env } = params;
  assert.equal(params.baselineVersion, "2026.9.2");
  assert.equal(params.build.candidateVersion, "2026.9.3");
  const evidenceDir = join(params.logsDir, "upgrade-transition");
  const backupDir = join(lane.rootDir, "private-upgrade-backup");
  mkdirSync(evidenceDir, { recursive: true });
  const helper = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../e2e/lib/external-package-transition.mjs",
  );
  const log = (name: string) => join(evidenceDir, name);
  const cli = (
    name: string,
    args: string[],
    options: { check?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ) =>
    runOpenClaw({
      lane,
      env,
      args,
      logPath: log(`${name}.log`),
      timeoutMs: 10 * 60 * 1000,
      ...options,
    });
  const assertion = async (name: string, args: string[]) => {
    const result = await runCommand(process.execPath, [helper, ...args], {
      env,
      cwd: lane.homeDir,
      logPath: log(`${name}.log`),
      timeoutMs: 60_000,
    });
    writeFileSync(log(`${name}.json`), result.stdout);
    return result.stdout;
  };
  const holder: { current: GatewayHandle | null } = { current: null };
  const port = await reserveGatewayPortForLane(lane);
  const start = async (stage: string) => {
    holder.current = await startGateway({ lane, env, logPath: log(`${stage}-gateway.log`) });
    await waitForGateway({
      lane,
      env,
      gatewayHolder: holder,
      gatewayLogPath: log(`${stage}-gateway.log`),
      logPath: log(`${stage}-ready.log`),
    });
  };
  const history = async (stage: string, sessionId: string) => {
    const listing = await cli(`${stage}-sessions`, ["sessions", "--json"]);
    writeFileSync(log(`${stage}-sessions.json`), listing.stdout);
    const key = await assertion(`${stage}-session-key`, [
      "session-key",
      log(`${stage}-sessions.json`),
      sessionId,
    ]);
    const result = await cli(`${stage}-history`, [
      "gateway",
      "call",
      "chat.history",
      "--json",
      "--params",
      JSON.stringify({ sessionKey: key.trim(), limit: 20 }),
    ]);
    writeFileSync(log(`${stage}-history.json`), result.stdout);
    await assertion(`${stage}-persisted`, ["history", log(`${stage}-history.json`), "OK"]);
    return key.trim();
  };
  const baselineSession = `release-upgrade-baseline-${randomUUID()}`;
  try {
    await runTimedLanePhase(lane, "prepare-baseline-state", async () => {
      await runOnboard({
        lane,
        env,
        providerConfig: params.providerConfig,
        logPath: log("baseline-onboard.log"),
      });
      await runModelsSet({
        lane,
        env,
        providerConfig: params.providerConfig,
        logPath: log("baseline-models.log"),
      });
      await port.release();
      await start("baseline");
      await cli("baseline-turn", buildReleaseAgentTurnArgs(baselineSession));
    });
    const baselineKey = await history("baseline", baselineSession);
    // These operator settings must survive Doctor; onboarding after migration would hide loss.
    const configBefore = await cli("config-before", ["config", "get", "agents.defaults", "--json"]);
    const defaultsBefore = JSON.parse(configBefore.stdout);
    await runTimedLanePhase(lane, "stop-baseline-and-backup", async () => {
      assert(holder.current);
      await stopGateway(holder.current);
      assert(hasChildExited(holder.current.child), "baseline Gateway did not finish stopping");
      holder.current = null;
      mkdirSync(backupDir, { mode: 0o700 });
      await cli("backup", [
        "backup",
        "create",
        "--verify",
        "--output",
        join(backupDir, "before.tar.gz"),
        "--json",
      ]);
    });
    const schemaBefore = JSON.parse(await assertion("schema-before", ["schema", "15"]));
    await runTimedLanePhase(lane, "packaged-self-update", async () => {
      const update = await cli("self-update", buildPackagedUpgradeUpdateArgs(params.candidateUrl), {
        env: buildRealUpdateEnv(env),
        check: false,
        timeoutMs: updateTimeoutMs(),
      });
      writeFileSync(log("self-update.json"), update.stdout);
      writeFileSync(log("self-update.err"), update.stderr);
      assert.equal(update.exitCode, 0, "packaged self-update failed");
      assert.equal(JSON.parse(update.stdout).status, "ok", "packaged self-update did not complete");
      verifyInstalledCandidate(readInstalledMetadata(lane.prefixDir), params.build);
    });
    // The 9.2 driver retains published schema 15 during its terminal grace period.
    // Applied content must already be 16; publication is owned by the product.
    const schemaAfterUpdate = JSON.parse(await assertion("schema-after-update", ["schema", "16"]));
    const configAfter = await cli("config-after", ["config", "get", "agents.defaults", "--json"]);
    assert.deepEqual(
      JSON.parse(configAfter.stdout),
      defaultsBefore,
      "operator agent defaults changed during transition",
    );
    await installLaneCompanions({ ...params, lane, env });
    await start("candidate");
    const presence = await cli("serving-version", ["gateway", "call", "system-presence", "--json"]);
    const entries = JSON.parse(presence.stdout) as Array<{
      mode?: string;
      reason?: string;
      version?: string;
    }>;
    const self = entries.find((entry) => entry.mode === "gateway" && entry.reason === "self");
    assert.equal(
      self?.version,
      params.build.candidateVersion,
      "serving Gateway is not the candidate",
    );
    assert.equal(
      await history("retained", baselineSession),
      baselineKey,
      "retained session key changed",
    );
    const candidateSession = `release-upgrade-candidate-${randomUUID()}`;
    await cli("candidate-turn", buildReleaseAgentTurnArgs(candidateSession));
    await history("candidate", candidateSession);
    await runDashboardSmoke({ lane, logPath: log("dashboard.log") });
    const schemaAfterServing = JSON.parse(
      await assertion("schema-after-serving", ["schema", "16"]),
    );
    const result = {
      method: "packaged-self-update",
      selfUpdatePassed: true,
      baselineVersion: params.baselineVersion,
      candidateVersion: params.build.candidateVersion,
      schemaBefore,
      schemaAfterUpdate,
      schemaAfterServing,
      status: "pass",
      installedVersion: params.build.candidateVersion,
      installedCommit: params.build.sourceSha,
      retainedSessionPassed: true,
      persistedCandidateTurnPassed: true,
      dashboardStatus: "pass",
      gatewayPort: lane.gatewayPort,
      phaseTimings: lane.phaseTimings,
    };
    writeFileSync(log("transition.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    try {
      await port.release();
      await stopGateway(holder.current);
    } finally {
      rmSync(backupDir, { recursive: true, force: true });
    }
  }
}
