import { theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveGatewayRestartLogPath } from "../../daemon/restart-logs.js";
import { resolveGatewayService } from "../../daemon/service.js";
import type { UpdateRepairValidation } from "../../infra/update-repair-protocol.js";
import { recordUpdateRunStep, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { verifyUpdateServing } from "../../infra/update-serving-verification.js";
import { defaultRuntime } from "../../runtime.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { resolveGatewayRestartProbeContext } from "../daemon-cli/restart-health-probe.js";
import {
  renderRestartDiagnostics,
  waitForGatewayHealthyRestart,
  waitForGatewayHttpReadiness,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { PostUpdateLaunchAgentRecoveryResult } from "./update-command-launch-agent-recovery.js";
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
  onVerified?: (verifiedAtMs: number) => void;
  recoverHealth?: (
    health: GatewayRestartSnapshot,
    reinspect: () => Promise<GatewayRestartSnapshot>,
  ) => Promise<{
    health: GatewayRestartSnapshot;
    launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null;
  }>;
}): Promise<UpdateRepairValidation> {
  params.signal?.throwIfAborted();
  const service = resolveGatewayService();
  const waitForHealthy = async () => {
    params.signal?.throwIfAborted();
    const health = await waitForGatewayHealthyRestart({
      service,
      port: params.gatewayPort,
      expectedVersion: params.expectedVersion,
      ...(params.expectedBuildId ? { expectedBuildId: params.expectedBuildId } : {}),
      env: params.serviceEnv,
      requireRunningService: params.requireRunningService,
      settle: { probes: 12 },
      ...(params.signal ? { signal: params.signal } : {}),
      supervisorKeepsAlive: await hasLoadedLaunchdKeepAliveSupervisor({
        service,
        env: params.serviceEnv,
      }),
    });
    params.signal?.throwIfAborted();
    return health;
  };
  let health = params.health ?? (await waitForHealthy());
  let launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null = null;
  if (params.recoverHealth) {
    ({ health, launchAgentRecovery } = await params.recoverHealth(health, waitForHealthy));
  }
  const context = await resolveGatewayRestartProbeContext(params.serviceEnv);
  params.signal?.throwIfAborted();
  const http = await waitForGatewayHttpReadiness({
    config: context.config,
    port: params.gatewayPort,
    attempts: 3,
    deadlineAt: Date.now() + 10_000,
    delayMs: 500,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();
  const readyz = http.readyz === 200;
  recordUpdateGatewayHealth(params.opts.run, health, params.gatewayPort, readyz);
  if (launchAgentRecovery?.attempted) {
    defaultRuntime.error(
      launchAgentRecovery.recovered ? launchAgentRecovery.message : launchAgentRecovery.detail,
    );
  }
  const serviceRunning = !params.requireRunningService || health.runtime.status === "running";
  if (health.healthy && serviceRunning && readyz) {
    const run = params.opts.run;
    const expectedVersion = params.expectedVersion;
    // A healthy port does not prove this update served or persisted a turn.
    // Missing transaction/artifact identity cannot be replaced with the observed boot.
    const serving =
      run && expectedVersion && health.gatewayBootId
        ? await verifyUpdateServing({
            runId: run.runId,
            config: context.config,
            env: params.serviceEnv,
            gatewayPort: params.gatewayPort,
            expectedVersion,
            expectedBuildId: params.expectedBuildId,
            expectedBootId: health.gatewayBootId,
            ...(params.signal ? { signal: params.signal } : {}),
          })
        : !run || !expectedVersion
          ? ({ status: "failed", reason: "invalid-request" } as const)
          : ({ status: "unavailable", reason: "identity-unavailable" } as const);
    params.signal?.throwIfAborted();
    if (run) {
      recordUpdateRunVerification(
        run.runId,
        {
          inferenceProbe:
            serving.status === "verified"
              ? "passed"
              : serving.status === "unavailable"
                ? "unavailable"
                : "failed",
        },
        { env: run.env },
      );
      recordUpdateRunStep(
        run.runId,
        {
          step: "gateway verification",
          status: serving.status === "verified" ? "completed" : "failed",
          endedAtMs: Date.now(),
          ...(serving.status === "verified" ? {} : { detail: serving.reason }),
        },
        { env: run.env },
      );
    }
    if (serving.status !== "verified") {
      // Only public-safe producer reasons leave this boundary; the receipt is private.
      const reason = `serving-verification-${serving.reason}`;
      defaultRuntime.error(`Gateway serving verification failed: ${serving.reason}.`);
      return { ok: false, score: 7, summary: reason };
    }
    params.onVerified?.(serving.receipt.verifiedAtMs);
    if (!params.opts.json) {
      defaultRuntime.log(
        theme.success("Gateway: restarted, served a turn, and verified persistence."),
      );
    }
    return {
      ok: true,
      score: 8,
      summary:
        "Gateway service, version, plugins, channels, readiness, and persisted turn verified.",
    };
  }
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
