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
const databaseCompatibilityModuleLoader = createLazyImportLoader(
  () => import("../state/openclaw-state-db-readonly.js"),
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
    rpc: {},
    configuredProbeUrl: params.probeUrl,
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

function nativeServiceTargetsGateway(status: DaemonStatus): boolean {
  return status.service.targetRole !== "diagnostic-only";
}

function readinessFailureReason(status: DaemonStatus): string {
  if (gatewayLooksStopped(status)) {
    return "Gateway is not running.";
  }
  return status.rpc?.error
    ? `Gateway probe failed: ${status.rpc.error}`
    : "Gateway is not healthy.";
}

function printGatewayNotReadyHints(
  runtime: RuntimeEnv,
  reason: string,
  nativeServiceCanRecover = true,
): void {
  runtime.log(reason);
  runtime.log("Run `openclaw gateway status --deep` for details.");
  if (!nativeServiceCanRecover) {
    runtime.log(
      "Use the owning environment or supervisor to start or repair the selected Gateway.",
    );
    return;
  }
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
  const nativeServiceCanRecover = nativeServiceTargetsGateway(initialStatus);
  if (
    nativeServiceCanRecover &&
    (initialStatus.service.loadState.status === "unknown" ||
      initialStatus.service.definitionError ||
      initialStatus.service.runtime?.inspectionFailure)
  ) {
    const inspectionReason = "Could not check the background Gateway service.";
    options.runtime.log(inspectionReason);
    options.runtime.log("Run `openclaw gateway status --deep` for the inspection failure.");
    return { ready: false, status: initialStatus, reason: inspectionReason, recoverable: false };
  }
  if (!gatewayLooksStopped(initialStatus) || !nativeServiceCanRecover) {
    printGatewayNotReadyHints(options.runtime, reason, nativeServiceCanRecover);
    return { ready: false, status: initialStatus, reason, recoverable: false };
  }

  const shouldInstall = !initialStatus.service.installed;
  if (shouldInstall && options.allowInstall === false) {
    printGatewayNotReadyHints(options.runtime, reason);
    return { ready: false, status: initialStatus, reason, recoverable: false };
  }

  // Reachable and externally managed Gateways return above: only local recovery
  // may open this install's state, before offering any service mutation.
  const { assertOpenClawStateDatabaseCompatible } = await databaseCompatibilityModuleLoader.load();
  try {
    await assertOpenClawStateDatabaseCompatible();
  } catch (error) {
    const compatibilityReason = error instanceof Error ? error.message : String(error);
    options.runtime.error(compatibilityReason);
    return { ready: false, status: initialStatus, reason: compatibilityReason, recoverable: false };
  }

  if (shouldInstall) {
    options.runtime.log(`OpenClaw needs a running Gateway to ${options.operation}.`);
    options.runtime.log("No background Gateway service was found for this profile.");
  }
  const prompt = shouldInstall
    ? `Install and start the background Gateway service to ${options.operation}?`
    : `The background Gateway service is installed but stopped. Start it to ${options.operation}?`;
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
  printGatewayNotReadyHints(
    options.runtime,
    recoveredReason,
    nativeServiceTargetsGateway(recoveredStatus),
  );
  return {
    ready: false,
    status: recoveredStatus,
    reason: recoveredReason,
    recoverable: true,
  };
}
