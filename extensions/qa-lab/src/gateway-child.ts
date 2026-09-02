import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runQaGatewayCliCommand } from "./gateway-child-command.js";
import { QaGatewayChildLifecycle, type QaGatewayStopOptions } from "./gateway-child-lifecycle.js";
import {
  formatQaGatewayProcessBoundaryStartupFailure,
  monitorQaGatewayChildFailure,
  throwQaGatewayChildFailure,
  type QaChildFailure,
} from "./gateway-child-process.js";
import {
  callQaGatewayWithRetry,
  isRetryableRpcStartupError,
  QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS,
  resolveQaGatewayStartupRetry,
  waitForGatewayListening,
  waitForGatewayReady,
  waitForQaGatewayRestartBoundary,
} from "./gateway-child-readiness.js";
import {
  prepareQaGatewayChild,
  type QaGatewayChildParams,
  type QaGatewayChildStateMutationContext,
} from "./gateway-child-setup.js";
import { redactQaGatewayDebugText } from "./gateway-log-redaction.js";
import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";
import { readProcessTreeCpuMs, readProcessTreeRssBytes } from "./process-tree-cpu.js";

export type { QaGatewayChildCommand } from "./gateway-child-command.js";
export type { QaGatewayStopResult, QaGatewayStopOptions } from "./gateway-child-lifecycle.js";
export type {
  QaGatewayChildListeningContext,
  QaGatewayChildStateMutationContext,
} from "./gateway-child-setup.js";
export type { QaCliBackendAuthMode } from "./providers/env.js";
export type QaGatewayChild = Awaited<ReturnType<typeof startOwnedGatewayChild>>;

export function createQaGatewayChild() {
  const lifetime = new QaGatewayChildLifecycle();
  let started = false;
  return {
    start(params: QaGatewayChildParams) {
      if (started) {
        throw new Error("qa gateway child startup already requested");
      }
      started = true;
      lifetime.repoRoot = params.repoRoot;
      return lifetime.run(() => startOwnedGatewayChild(params, lifetime));
    },
    stop: (opts?: QaGatewayStopOptions) => lifetime.stop(opts),
  };
}

async function startOwnedGatewayChild(
  params: QaGatewayChildParams,
  lifetime: QaGatewayChildLifecycle,
) {
  const setup = await prepareQaGatewayChild(params, lifetime);
  const {
    output,
    logs,
    stdoutLog,
    stderrLog,
    nodeExecPath,
    gatewayCwd,
    cliArgsPrefix,
    workspaceDir,
    stateDir,
    tempRoot,
    configPath,
    gatewayToken,
  } = setup;
  let active!: ReturnType<QaGatewayChildLifecycle["register"]>;
  let getChildFailure: (() => QaChildFailure | null) | undefined;
  let launch!: Awaited<ReturnType<typeof setup.prepareAttempt>>;
  const requireRpcClient = () => {
    if (!lifetime.rpcClient) {
      throw new Error("qa gateway rpc client is not ready");
    }
    return lifetime.rpcClient;
  };
  const throwActiveChildFailure = () => {
    lifetime.assertOpen();
    throwQaGatewayChildFailure(getChildFailure, logs);
  };
  const stopAttempt = async (startupError?: unknown) => {
    const result = await lifetime.stopProcess();
    const errors = [...result.errors];
    try {
      await lifetime.rpcClient?.stop();
    } catch (error) {
      errors.push(error);
    }
    lifetime.rpcClient = null;
    if (errors.length) {
      throw new AggregateError(
        startupError === undefined ? errors : [startupError, ...errors],
        "qa gateway attempt cleanup failed",
        { cause: startupError },
      );
    }
  };
  const launchReady = async (initial: boolean, attempt = 1) => {
    lifetime.assertOpen();
    const gatewayArgs = setup.buildGatewayArgs();
    const prepared = lifetime.controller
      ? await lifetime.controller.prepare({ args: gatewayArgs, cwd: gatewayCwd, env: launch.env })
      : null;
    lifetime.assertOpen();
    const child = spawn(nodeExecPath, gatewayArgs, {
      cwd: gatewayCwd,
      env: prepared?.env ?? launch.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Register synchronously: acceptance/readiness may reject with descendants
    // still alive, and replacement must immediately supersede its stopped parent.
    active = lifetime.register(child, prepared);
    for (const [stream, label, log] of [
      [child.stdout, "stdout", stdoutLog],
      [child.stderr, "stderr", stderrLog],
    ] as const) {
      stream.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        output.push(label, buffer);
        log.write(buffer);
      });
    }
    getChildFailure = monitorQaGatewayChildFailure(child, output);
    active.checkFailure = () => throwQaGatewayChildFailure(getChildFailure, logs);
    try {
      if (prepared && lifetime.controller) {
        active.identity = await lifetime.controller.accept({ child, prepared });
        lifetime.assertOpen();
        await lifetime.controller.signal(active.identity, "SIGCONT");
      }
    } catch (error) {
      throw new Error(formatQaGatewayProcessBoundaryStartupFailure(error, logs()), {
        cause: error,
      });
    }
    lifetime.assertOpen();
    const health = { baseUrl: launch.baseUrl, logs, child, getChildFailure, timeoutMs: 120_000 };
    if (initial) {
      await waitForGatewayListening(health);
      lifetime.assertOpen();
      await params.onListening?.({
        attempt,
        baseUrl: launch.baseUrl,
        wsUrl: launch.wsUrl,
        token: gatewayToken,
        configPath,
        runtimeEnv: launch.env,
      });
    }
    if (!initial || !params.allowUnhealthyStartup) {
      await waitForGatewayReady(health);
    }
    lifetime.assertOpen();
    lifetime.rpcClient = await startQaGatewayRpcClient({
      wsUrl: launch.wsUrl,
      token: gatewayToken,
      logs,
    });
    for (let rpcAttempt = 1; ; rpcAttempt += 1) {
      lifetime.assertOpen();
      try {
        await lifetime.rpcClient.request("config.get", {}, { timeoutMs: 30_000 });
        break;
      } catch (error) {
        if (rpcAttempt >= 4 || !isRetryableRpcStartupError(error)) {
          throw error;
        }
        await sleep(500 * rpcAttempt);
        await waitForGatewayReady({ ...health, timeoutMs: initial ? 60_000 : 15_000 });
      }
    }
    throwActiveChildFailure();
    if (active.identity && lifetime.controller) {
      await lifetime.controller.markReady(active.identity);
    }
    lifetime.assertOpen();
    active.ready = true;
  };
  let migrationConvergenceRestartUsed = false;
  let reuseStartupLaunchState = false;
  for (let attempt = 1; attempt <= QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS; attempt += 1) {
    launch = await setup.prepareAttempt(reuseStartupLaunchState);
    const attemptLogMark = output.mark();
    try {
      await launchReady(true, attempt);
      break;
    } catch (error) {
      const attemptLogs = redactQaGatewayDebugText(output.readSince(attemptLogMark));
      const retry = resolveQaGatewayStartupRetry({
        attempt,
        details: attemptLogs.trim() ? attemptLogs : formatErrorMessage(error),
        migrationConvergenceRestartUsed,
      });
      const retryableRpcStartup =
        attempt < QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS &&
        !retry &&
        isRetryableRpcStartupError(error);
      if (!retry && !retryableRpcStartup) {
        throw error;
      }
      await stopAttempt(error);
      lifetime.assertOpen();
      migrationConvergenceRestartUsed =
        retry?.migrationConvergenceRestartUsed ?? migrationConvergenceRestartUsed;
      reuseStartupLaunchState = retry?.reuseLaunchState ?? false;
      const retryMessage =
        retry?.kind === "migration-convergence-restart"
          ? `[qa-lab] gateway child startup attempt ${attempt}/${QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS} completed plugin migration convergence; restarting once with the same state, config, and port ${launch.gatewayPort}\n`
          : `[qa-lab] gateway child startup attempt ${attempt}/${QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS} hit a transient startup race on port ${launch.gatewayPort}; retrying with a new port\n`;
      const retryBuffer = Buffer.from(retryMessage);
      output.push("internal", retryBuffer);
      stdoutLog.write(retryBuffer);
    }
  }
  const { cfg, baseUrl, wsUrl, env: runningEnv } = launch;
  const signalActiveProcess = async (signal: NodeJS.Signals) => {
    if (active.identity && lifetime.controller) {
      if (signal !== "SIGUSR1" && signal !== "SIGUSR2") {
        throw new Error(`unsupported verified gateway signal: ${signal}`);
      }
      await lifetime.controller.signal(active.identity, signal);
      return;
    }
    if (!active.child.pid) {
      throw new Error("qa gateway child has no pid");
    }
    process.kill(active.child.pid, signal);
  };

  return {
    cfg,
    baseUrl,
    wsUrl,
    get pid() {
      return active.identity?.pid ?? active.child.pid ?? null;
    },
    getProcessCpuMs: () => readProcessTreeCpuMs(active.identity?.pid ?? active.child.pid ?? null),
    getProcessRssBytes: () =>
      readProcessTreeRssBytes(active.identity?.pid ?? active.child.pid ?? null),
    token: gatewayToken,
    workspaceDir,
    tempRoot,
    configPath,
    runtimeEnv: runningEnv,
    logs,
    runCli(args: readonly string[]) {
      throwActiveChildFailure();
      return runQaGatewayCliCommand({
        lifetime,
        executablePath: nodeExecPath,
        argsPrefix: cliArgsPrefix,
        args,
        cwd: gatewayCwd,
        env: runningEnv,
      });
    },
    async signalProcess(signal: NodeJS.Signals) {
      throwActiveChildFailure();
      await signalActiveProcess(signal);
    },
    async restart(signal: NodeJS.Signals = "SIGUSR1") {
      throwActiveChildFailure();
      const restartLogMark = output.mark();
      await signalActiveProcess(signal);
      if (signal === "SIGUSR1") {
        await waitForQaGatewayRestartBoundary({
          readLogsSince: (mark) => redactQaGatewayDebugText(output.readSince(mark)),
          mark: restartLogMark,
        });
        await waitForGatewayReady({
          baseUrl,
          logs,
          child: active.child,
          getChildFailure,
          timeoutMs: 120_000,
        });
      }
    },
    restartAfterStateMutation(
      mutateState: (context: QaGatewayChildStateMutationContext) => Promise<void>,
    ) {
      return lifetime.run(async () => {
        throwActiveChildFailure();
        await stopAttempt();
        await mutateState({ configPath, runtimeEnv: runningEnv, stateDir, tempRoot });
        const replacementLogMark = output.mark();
        try {
          await launchReady(false);
        } catch (error) {
          const retry = resolveQaGatewayStartupRetry({
            attempt: 1,
            details: [
              redactQaGatewayDebugText(output.readSince(replacementLogMark)),
              formatErrorMessage(error),
            ].join("\n"),
            migrationConvergenceRestartUsed: false,
          });
          if (retry?.kind !== "migration-convergence-restart") {
            throw error;
          }
          await stopAttempt(error);
          const retryBuffer = Buffer.from(
            "[qa-lab] replacement gateway completed plugin migration convergence; restarting once with the same state, config, and port\n",
          );
          output.push("internal", retryBuffer);
          stdoutLog.write(retryBuffer);
          await launchReady(false);
        }
      });
    },
    async call(
      method: string,
      rpcParams?: unknown,
      opts?: { deadlineMs?: number; expectFinal?: boolean; timeoutMs?: number },
    ) {
      const timeoutMs = opts?.timeoutMs ?? 20_000;
      return await callQaGatewayWithRetry({
        deadlineMs: opts?.deadlineMs,
        logs,
        request: async (requestOptions) =>
          await requireRpcClient().request(method, rpcParams, {
            ...opts,
            ...requestOptions,
          }),
        throwChildFailure: throwActiveChildFailure,
        timeoutMs,
        waitForReady: async (readinessTimeoutMs) =>
          await waitForGatewayReady({
            baseUrl,
            logs,
            child: active.child,
            getChildFailure,
            timeoutMs: readinessTimeoutMs,
          }),
      });
    },
    async stop(opts?: QaGatewayStopOptions) {
      const result = await lifetime.stop(opts);
      if (result.errors.length) {
        throw new AggregateError(
          result.errors,
          `qa gateway child cleanup failed: ${result.errors.map(formatErrorMessage).join("; ")}`,
        );
      }
    },
  };
}
