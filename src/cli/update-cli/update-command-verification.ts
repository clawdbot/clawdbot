import { theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveGatewayRestartLogPath } from "../../daemon/restart-logs.js";
import { resolveGatewayService } from "../../daemon/service.js";
import type { UpdateRepairValidation } from "../../infra/update-repair-protocol.js";
import { recordUpdateRunStep, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { resolveGatewayRestartProbeContext } from "../daemon-cli/restart-health-probe.js";
import {
  inspectGatewayRestart,
  renderRestartDiagnostics,
  waitForGatewayHealthyRestart,
  waitForGatewayHttpReadiness,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { PostUpdateLaunchAgentRecoveryResult } from "./update-command-launch-agent-recovery.js";
import {
  assertUpdateCommandRecovery,
  persistUpdateCommandServingReceipt,
  UpdateCommandRecoveryPendingError,
} from "./update-command-recovery.js";
import {
  formatPostUpdateGatewayRecoveryInstructions,
  hasLoadedLaunchdKeepAliveSupervisor,
} from "./update-command-service-recovery.js";

export function recordUpdateGatewayHealth(
  run: UpdateCommandOptions["run"],
  health: GatewayRestartSnapshot,
  port: number,
  readyz = false,
): void {
  if (!run) {
    return;
  }
  recordUpdateRunVerification(
    run.runId,
    {
      serviceRunning: health.runtime.status === "running",
      ...(typeof health.runtime.pid === "number" ? { pid: health.runtime.pid } : {}),
      port,
      ...(health.gatewayVersion ? { runningVersion: health.gatewayVersion } : {}),
      ...(health.gatewayBuildId ? { runningBuildId: health.gatewayBuildId } : {}),
      ...(health.expectedVersion
        ? {
            versionMatch:
              health.gatewayVersion === health.expectedVersion && !health.buildIdMismatch,
          }
        : {}),
      pluginErrors: health.activatedPluginErrors?.map((error) => JSON.stringify(error)) ?? [],
      channelsReady: health.healthy && !health.channelProbeErrors?.length,
      settled: health.healthy,
      readyz,
    },
    { env: run.env },
  );
}

/** The same independent oracles decide ordinary restart and repair outcomes. */
export async function verifyUpdatedGateway(params: {
  result: UpdateRunResult;
  opts: UpdateCommandOptions;
  serviceEnv: NodeJS.ProcessEnv;
  gatewayPort: number;
  nodeRunner?: string;
  expectedVersion?: string;
  expectedBuildId?: string;
  requireRunningService?: boolean;
  health?: GatewayRestartSnapshot;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onVerified?: (verifiedAtMs: number) => void;
  recoverHealth?: (
    health: GatewayRestartSnapshot,
    reinspect: () => Promise<GatewayRestartSnapshot>,
  ) => Promise<{
    health: GatewayRestartSnapshot;
    launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null;
  }>;
}): Promise<UpdateRepairValidation> {
  // Proof belongs to the recovery record that began this observation. Reloading
  // the executor's newest record after an await could bless a reclaimed run.
  const originalRun = params.opts.run;
  const originalRecovery = params.opts.recovery;
  const proofOptions = {
    ...params.opts,
    ...(originalRun ? { run: { ...originalRun, env: { ...originalRun.env } } } : {}),
  };
  let expectedRecovery = originalRecovery
    ? structuredClone(originalRecovery.getRecord())
    : undefined;
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    if (params.opts.run !== originalRun || params.opts.recovery !== originalRecovery) {
      throw new UpdateCommandRecoveryPendingError("Readiness observation lost its admitted owner.");
    }
    if (originalRecovery) {
      assertUpdateCommandRecovery(proofOptions, expectedRecovery);
    }
  };
  assertCurrent();
  const service = resolveGatewayService();
  const waitForHealthy = async () => {
    assertCurrent();
    const supervisorKeepsAlive = await hasLoadedLaunchdKeepAliveSupervisor({
      service,
      env: params.serviceEnv,
    });
    assertCurrent();
    const health = await waitForGatewayHealthyRestart({
      service,
      port: params.gatewayPort,
      expectedVersion: params.expectedVersion,
      ...(params.expectedBuildId ? { expectedBuildId: params.expectedBuildId } : {}),
      env: params.serviceEnv,
      requireRunningService: params.requireRunningService,
      settle: { probes: 12 },
      ...(params.signal ? { signal: params.signal } : {}),
      supervisorKeepsAlive,
    });
    assertCurrent();
    return health;
  };
  let health = params.health ?? (await waitForHealthy());
  let launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null = null;
  if (params.recoverHealth) {
    ({ health, launchAgentRecovery } = await params.recoverHealth(health, waitForHealthy));
    assertCurrent();
  }
  const context = await resolveGatewayRestartProbeContext(params.serviceEnv);
  assertCurrent();
  const http = await waitForGatewayHttpReadiness({
    config: context.config,
    port: params.gatewayPort,
    attempts: 3,
    deadlineAt: Date.now() + 10_000,
    delayMs: 500,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  assertCurrent();
  const readyz = http.readyz === 200;
  if (expectedRecovery && health.healthy && health.runtime.status === "running" && readyz) {
    const restart = expectedRecovery.effects.at(-1);
    const identity = restart?.runtime === "previous" ? expectedRecovery.from : expectedRecovery.to;
    // HTTP has no boot identity. Sandwich it between authenticated health probes
    // so readiness cannot combine different gateway lifetimes.
    const finalHealth = await inspectGatewayRestart({
      service,
      port: params.gatewayPort,
      env: params.serviceEnv,
      expectedVersion: identity.version,
      ...(identity.buildId ? { expectedBuildId: identity.buildId } : {}),
      probeContext: context,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    assertCurrent();
    if (
      !health.healthy ||
      health.runtime.status !== "running" ||
      !health.gatewayBootId ||
      !finalHealth.healthy ||
      finalHealth.runtime.status !== "running" ||
      health.gatewayBootId !== finalHealth.gatewayBootId ||
      health.gatewayVersion !== finalHealth.gatewayVersion ||
      health.gatewayBuildId !== finalHealth.gatewayBuildId ||
      health.activatedPluginErrors?.length ||
      health.channelProbeErrors?.length ||
      finalHealth.activatedPluginErrors?.length ||
      finalHealth.channelProbeErrors?.length
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Readiness did not remain on the observed running gateway.",
      );
    }
    health = finalHealth;
  }
  if (launchAgentRecovery?.attempted) {
    defaultRuntime.error(
      launchAgentRecovery.recovered ? launchAgentRecovery.message : launchAgentRecovery.detail,
    );
  }
  const serviceRunning =
    !(params.requireRunningService || expectedRecovery) || health.runtime.status === "running";
  if (health.healthy && serviceRunning && readyz) {
    assertCurrent();
    const verifiedAtMs = Date.now();
    if (expectedRecovery) {
      const restart = expectedRecovery.effects.at(-1);
      if (
        restart?.kind !== "service-restart" ||
        restart.state !== "observed" ||
        !health.gatewayBootId ||
        !health.gatewayVersion ||
        health.gatewayBuildId === undefined
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Readiness requires the observed restart identity.",
        );
      }
      expectedRecovery = persistUpdateCommandServingReceipt(proofOptions, {
        kind: "readiness",
        runId: expectedRecovery.runId,
        transactionId: expectedRecovery.transactionId,
        claimId: expectedRecovery.claimId,
        revision: expectedRecovery.revision,
        effectId: restart.effectId,
        runtime: restart.runtime,
        gateway: {
          bootId: health.gatewayBootId,
          version: health.gatewayVersion,
          buildId: health.gatewayBuildId,
        },
        checks: {
          serviceRunning: true,
          pluginsReady: true,
          channelsReady: true,
          settled: true,
          readyz: true,
        },
        verifiedAtMs,
      });
      assertCurrent();
    }
    recordUpdateGatewayHealth(proofOptions.run, health, params.gatewayPort, readyz);
    params.onVerified?.(verifiedAtMs);
    assertCurrent();
    if (params.opts.run) {
      recordUpdateRunStep(
        params.opts.run.runId,
        { step: "gateway verification", status: "completed", endedAtMs: Date.now() },
        { env: params.opts.run.env },
      );
    }

    if (!params.opts.json) {
      defaultRuntime.log(theme.success("Gateway: restarted and verified."));
    }
    return {
      ok: true,
      score: 7,
      summary: "Gateway service, version, plugins, channels, and readiness verified.",
    };
  }
  recordUpdateGatewayHealth(proofOptions.run, health, params.gatewayPort, readyz);
  const diagnosticLines: [string, ...string[]] = [
    "Gateway did not become healthy after restart.",
    ...(!readyz ? ["Gateway /readyz did not return HTTP 200."] : []),
    ...(health.healthy && params.requireRunningService
      ? ["Gateway responded, but the managed service did not report running after restart."]
      : []),
    ...renderRestartDiagnostics(health),
    ...(launchAgentRecovery?.attempted
      ? [
          launchAgentRecovery.recovered
            ? `LaunchAgent recovery: ${launchAgentRecovery.message}`
            : `LaunchAgent recovery failed: ${launchAgentRecovery.detail}`,
        ]
      : []),
    `Restart log: ${resolveGatewayRestartLogPath(params.serviceEnv)}`,
    `Run \`${replaceCliName(formatCliCommand("openclaw gateway status --deep"), resolveCliName())}\` for details.`,
    ...formatPostUpdateGatewayRecoveryInstructions(params.result),
  ];
  const reason = health.versionMismatch
    ? "version-mismatch"
    : health.buildIdMismatch
      ? "build-id-mismatch"
      : health.activatedPluginErrors?.length
        ? "plugin-errors"
        : health.channelProbeErrors?.length
          ? "channel-errors"
          : !readyz
            ? "readyz-unhealthy"
            : !serviceRunning
              ? "service-not-running"
              : (health.waitOutcome ?? "restart-unhealthy");
  if (params.opts.run) {
    recordUpdateRunStep(
      params.opts.run.runId,
      {
        step: "gateway verification",
        status: "failed",
        endedAtMs: Date.now(),
        detail: !readyz ? "Gateway /readyz did not return HTTP 200." : reason,
      },
      { env: params.opts.run.env },
    );
  }
  if (params.opts.json) {
    defaultRuntime.error(diagnosticLines.join("\n"));
  } else {
    defaultRuntime.log(theme.warn(diagnosticLines[0]));
    for (const line of diagnosticLines.slice(1)) {
      defaultRuntime.log(theme.muted(line));
    }
  }
  const score = [
    serviceRunning,
    !health.versionMismatch,
    !health.buildIdMismatch,
    !health.activatedPluginErrors?.length,
    !health.channelProbeErrors?.length,
    health.healthy,
    readyz,
  ].filter(Boolean).length;
  return { ok: false, score, summary: reason };
}
