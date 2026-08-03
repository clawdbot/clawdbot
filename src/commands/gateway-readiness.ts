/** Ensures the managed gateway is available before commands that need it run. */
import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";
import { promptYesNo } from "../cli/prompt.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { gatewayProbeResultSawGateway } from "./gateway-health-auth-diagnostic.js";

const daemonStatusModuleLoader = createLazyImportLoader(
  () => import("../cli/daemon-cli/status.gather.js"),
);
const daemonInstallModuleLoader = createLazyImportLoader(
  () => import("../cli/daemon-cli/install.runtime.js"),
);
const daemonLifecycleModuleLoader = createLazyImportLoader(
  () => import("../cli/daemon-cli/lifecycle.js"),
);

/** Result returned after checking, optionally installing, and optionally starting the gateway. */
type GatewayReadinessResult =
  | {
      ready: true;
      status: DaemonStatus;
      recovered: boolean;
    }
  | {
      ready: false;
      status: DaemonStatus;
      reason: string;
      recoverable: boolean;
    };

type GatewayReadinessDeps = {
  gatherStatus?: () => Promise<DaemonStatus>;
  confirm?: (message: string, defaultYes?: boolean) => Promise<boolean>;
  installGateway?: () => Promise<void>;
  startGateway?: () => Promise<void>;
};

/** Inputs controlling readiness checks, recovery prompts, and injectable test seams. */
type GatewayReadinessOptions = {
  runtime: RuntimeEnv;
  operation: string;
  yes?: boolean;
  allowInstall?: boolean;
  requireRpc?: boolean;
  probeUrl?: string;
  readyWhenReachable?: boolean;
  interactive?: boolean;
  deps?: GatewayReadinessDeps;
};

async function defaultGatherStatus(params: {
  requireRpc: boolean;
  probeUrl?: string;
}): Promise<DaemonStatus> {
  const { gatherDaemonStatus } = await daemonStatusModuleLoader.load();
  return gatherDaemonStatus({
    rpc: params.probeUrl ? { url: params.probeUrl } : {},
    probe: true,
    requireRpc: params.requireRpc,
    deep: false,
  });
}

function activeProbePortStatus(status: DaemonStatus): DaemonStatus["port"] {
  const probeUrl = status.rpc?.url ?? status.gateway?.probeUrl;
  const probePort = probeUrl
    ? (() => {
        try {
          return Number(new URL(probeUrl).port);
        } catch {
          return Number.NaN;
        }
      })()
    : Number.NaN;
  if (Number.isFinite(probePort) && status.portCli?.port === probePort) {
    return status.portCli;
  }
  return status.port;
}

function gatewayIsRunning(status: DaemonStatus): boolean {
  return status.rpc?.ok === true;
}

function gatewayProbeSawGateway(status: DaemonStatus): boolean {
  return Boolean(status.rpc && gatewayProbeResultSawGateway(status.rpc));
}

function gatewayLooksReachable(status: DaemonStatus): boolean {
  if (gatewayIsRunning(status)) {
    return true;
  }
  const port = activeProbePortStatus(status);
  if (port?.status !== "busy") {
    return false;
  }
  // A busy port alone is not enough: pair it with probe evidence so another
  // local service on the same port cannot satisfy gateway readiness.
  return gatewayProbeSawGateway(status);
}

function gatewayIsReady(status: DaemonStatus, options: { readyWhenReachable?: boolean }): boolean {
  return (
    gatewayIsRunning(status) ||
    (options.readyWhenReachable === true && gatewayLooksReachable(status))
  );
}

function gatewayLooksStopped(status: DaemonStatus): boolean {
  if (status.rpc?.ok === true) {
    return false;
  }
  const port = activeProbePortStatus(status);
  if (port?.status === "free") {
    return true;
  }
  const runtimeStatus = status.service.runtime?.status;
  if (runtimeStatus === "stopped") {
    return true;
  }
  const error = status.rpc?.error ?? "";
  return /\bECONNREFUSED\b|couldn't connect|connection refused/i.test(error);
}

function gatewayServiceIsInstalled(status: DaemonStatus): boolean {
  return Boolean(status.service.command || status.service.loaded);
}

function readinessFailureReason(status: DaemonStatus): string {
  if (gatewayLooksStopped(status)) {
    return "Gateway is not running.";
  }
  return status.rpc?.error
    ? `Gateway probe failed: ${status.rpc.error}`
    : "Gateway is not healthy.";
}

function printGatewayNotReadyHints(runtime: RuntimeEnv, reason: string): void {
  runtime.log(reason);
  runtime.log("Run `openclaw gateway status --deep` for details.");
  runtime.log("Run `openclaw gateway start` to start a managed gateway.");
  runtime.log("Run `openclaw gateway run` for a foreground gateway.");
}

async function confirmRecovery(params: {
  message: string;
  yes?: boolean;
  interactive?: boolean;
  confirm: (message: string, defaultYes?: boolean) => Promise<boolean>;
}): Promise<boolean> {
  if (params.yes) {
    return true;
  }
  if (!(params.interactive ?? process.stdin.isTTY)) {
    return false;
  }
  return params.confirm(params.message, true);
}

async function waitForGatewayReady(params: {
  gatherStatus: () => Promise<DaemonStatus>;
  readyWhenReachable?: boolean;
  attempts?: number;
  delayMs?: number;
}): Promise<DaemonStatus> {
  const attempts = params.attempts ?? 20;
  const delayMs = params.delayMs ?? 500;
  let latest = await params.gatherStatus();
  for (
    let attempt = 1;
    attempt < attempts &&
    !gatewayIsReady(latest, { readyWhenReachable: params.readyWhenReachable });
    attempt += 1
  ) {
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
    latest = await params.gatherStatus();
  }
  return latest;
}

/** Checks readiness and, when approved, recovers by installing or starting the gateway. */
export async function ensureGatewayReadyForOperation(
  options: GatewayReadinessOptions,
): Promise<GatewayReadinessResult> {
  const requireRpc = options.requireRpc ?? false;
  const gatherStatus =
    options.deps?.gatherStatus ??
    (() => defaultGatherStatus({ requireRpc, probeUrl: options.probeUrl }));
  const confirm = options.deps?.confirm ?? promptYesNo;
  const installGateway =
    options.deps?.installGateway ??
    (async () => {
      const { runDaemonInstall } = await daemonInstallModuleLoader.load();
      await runDaemonInstall({ json: false });
    });
  const startGateway =
    options.deps?.startGateway ??
    (async () => {
      const { runDaemonStart } = await daemonLifecycleModuleLoader.load();
      await runDaemonStart({ json: false });
    });

  const initialStatus = await gatherStatus();
  if (gatewayIsReady(initialStatus, { readyWhenReachable: options.readyWhenReachable })) {
    return { ready: true, status: initialStatus, recovered: false };
  }

  const reason = readinessFailureReason(initialStatus);
  if (!gatewayLooksStopped(initialStatus)) {
    printGatewayNotReadyHints(options.runtime, reason);
    return { ready: false, status: initialStatus, reason, recoverable: false };
  }

  const serviceInstalled = gatewayServiceIsInstalled(initialStatus);
  const shouldInstall = !serviceInstalled;
  if (shouldInstall && options.allowInstall === false) {
    printGatewayNotReadyHints(options.runtime, reason);
    return { ready: false, status: initialStatus, reason, recoverable: false };
  }

  const prompt = shouldInstall
    ? `Gateway is not installed. Install and start it now so OpenClaw can ${options.operation}?`
    : `Gateway is not running. Start it now so OpenClaw can ${options.operation}?`;
  const approved = await confirmRecovery({
    message: prompt,
    yes: options.yes,
    interactive: options.interactive,
    confirm,
  });
  if (!approved) {
    printGatewayNotReadyHints(options.runtime, reason);
    return { ready: false, status: initialStatus, reason, recoverable: true };
  }

  if (shouldInstall) {
    await installGateway();
  } else {
    await startGateway();
  }

  const recoveredStatus = await waitForGatewayReady({
    gatherStatus,
    readyWhenReachable: options.readyWhenReachable,
  });
  if (gatewayIsReady(recoveredStatus, { readyWhenReachable: options.readyWhenReachable })) {
    return { ready: true, status: recoveredStatus, recovered: true };
  }

  const recoveredReason = readinessFailureReason(recoveredStatus);
  printGatewayNotReadyHints(options.runtime, recoveredReason);
  return {
    ready: false,
    status: recoveredStatus,
    reason: recoveredReason,
    recoverable: true,
  };
}
