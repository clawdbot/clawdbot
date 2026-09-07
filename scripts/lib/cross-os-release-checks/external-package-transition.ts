import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseAgentTurnArgs } from "./agent.ts";
import type { CandidateBuild, GatewayHandle, LaneBaseParams, LaneState } from "./config.ts";
import { buildPackagedUpgradeUpdateArgs, buildRealUpdateEnv, updateTimeoutMs } from "./config.ts";
import {
  installTarballPackage,
  readInstalledMetadata,
  verifyInstalledCandidate,
} from "./install.ts";
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

// This release pair requires an explicitly different operator-owned transition.
// A refused self-update remains negative evidence, never an install fallback.
export async function runExternalPackageTransition(
  params: LaneBaseParams & {
    lane: LaneState;
    env: NodeJS.ProcessEnv;
    build: CandidateBuild;
    candidateUrl: string;
    baselineVersion: string;
  },
) {
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
    await runTimedLanePhase(lane, "prove-self-update-refusal", async () => {
      await assertion("schema-before", ["schema", "15"]);
      const refusal = await cli(
        "self-update",
        buildPackagedUpgradeUpdateArgs(params.candidateUrl),
        {
          env: buildRealUpdateEnv(env),
          check: false,
          timeoutMs: updateTimeoutMs(),
        },
      );
      writeFileSync(log("self-update.json"), refusal.stdout);
      writeFileSync(log("self-update.err"), refusal.stderr);
      await assertion("self-update-refusal", [
        "refusal",
        String(refusal.exitCode),
        log("self-update.json"),
        log("self-update.err"),
      ]);
      await assertion("schema-after-refusal", ["schema", "15"]);
    });
    await runTimedLanePhase(lane, "external-package-manager-and-fresh-doctor", async () => {
      await installTarballPackage({
        lane,
        env,
        tgzPath: params.build.candidateTgz,
        logPath: log("install.log"),
      });
      verifyInstalledCandidate(readInstalledMetadata(lane.prefixDir), params.build);
      await cli("doctor", ["doctor", "--fix", "--non-interactive"]);
      await assertion("schema-after-doctor", ["schema", "16"]);
    });
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
    await assertion("transition", [
      "receipt",
      params.baselineVersion,
      params.build.candidateVersion,
      evidenceDir,
    ]);
    return {
      ...JSON.parse(readFileSync(log("transition.json"), "utf8")),
      status: "pass",
      installedVersion: params.build.candidateVersion,
      installedCommit: params.build.sourceSha,
      retainedSessionPassed: true,
      persistedCandidateTurnPassed: true,
      dashboardStatus: "pass",
      gatewayPort: lane.gatewayPort,
      phaseTimings: lane.phaseTimings,
    };
  } finally {
    try {
      await port.release();
      await stopGateway(holder.current);
    } finally {
      rmSync(backupDir, { recursive: true, force: true });
    }
  }
}
