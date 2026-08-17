// Qa Lab plugin module owns gateway readiness and retry behavior.
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { QaSuiteInfraError } from "./errors.js";
import {
  hasQaGatewayChildExited,
  type QaChildFailure,
  throwQaGatewayChildFailure,
} from "./gateway-child-process.js";
import { formatQaGatewayLogsForError } from "./gateway-log-redaction.js";

export const QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS = 5;
const QA_GATEWAY_CHILD_RESTART_BOUNDARY_TIMEOUT_MS = 90_000;
const QA_GATEWAY_MIGRATION_CONVERGENCE_RESTART_PREFIX =
  "OpenClaw plugin migration inputs changed during startup convergence;";

type QaGatewayStartupRetryKind = "bind-collision" | "migration-convergence-restart";

type QaGatewayHealthChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function classifyQaGatewayStartupRetry(details: string): QaGatewayStartupRetryKind | null {
  if (details.includes(QA_GATEWAY_MIGRATION_CONVERGENCE_RESTART_PREFIX)) {
    return "migration-convergence-restart";
  }
  if (
    details.includes("another gateway instance is already listening on ws://") ||
    details.includes("failed to bind gateway socket on ws://") ||
    details.includes("EADDRINUSE") ||
    details.includes("address already in use")
  ) {
    return "bind-collision";
  }
  return null;
}

export function resolveQaGatewayStartupRetry(params: {
  attempt: number;
  details: string;
  migrationConvergenceRestartUsed: boolean;
}) {
  if (params.attempt >= QA_GATEWAY_CHILD_STARTUP_MAX_ATTEMPTS) {
    return null;
  }
  const kind = classifyQaGatewayStartupRetry(params.details);
  if (
    !kind ||
    (kind === "migration-convergence-restart" && params.migrationConvergenceRestartUsed)
  ) {
    return null;
  }
  return {
    kind,
    reuseLaunchState: kind === "migration-convergence-restart",
    migrationConvergenceRestartUsed:
      params.migrationConvergenceRestartUsed || kind === "migration-convergence-restart",
  };
}

function isRetryableGatewayCallError(details: string): boolean {
  return (
    details.includes("handshake timeout") ||
    details.includes("gateway closed (1000") ||
    details.includes("gateway closed (1012)") ||
    details.includes("gateway closed (1006") ||
    details.includes("abnormal closure") ||
    details.includes("service restart")
  );
}

export async function callQaGatewayWithRetry<T>(params: {
  deadlineMs?: number;
  logs: () => string;
  request: (options: { deadlineMs?: number; timeoutMs: number }) => Promise<T>;
  throwChildFailure: () => void;
  timeoutMs: number;
  waitForReady: (timeoutMs: number) => Promise<void>;
}) {
  const remainingMs = () =>
    params.deadlineMs === undefined ? undefined : params.deadlineMs - Date.now();
  const deadlineError = () =>
    new Error(`gateway call deadline exceeded${formatQaGatewayLogsForError(params.logs())}`);
  let lastDetails = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    params.throwChildFailure();
    const requestRemainingMs = remainingMs();
    if (requestRemainingMs !== undefined && requestRemainingMs <= 0) {
      throw deadlineError();
    }
    try {
      return await params.request({
        ...(params.deadlineMs === undefined ? {} : { deadlineMs: params.deadlineMs }),
        timeoutMs:
          requestRemainingMs === undefined
            ? params.timeoutMs
            : Math.min(params.timeoutMs, requestRemainingMs),
      });
    } catch (error) {
      params.throwChildFailure();
      const details = formatErrorMessage(error);
      lastDetails = details;
      if (attempt >= 3 || !isRetryableGatewayCallError(details)) {
        throw new Error(`${details}${formatQaGatewayLogsForError(params.logs())}`, {
          cause: error,
        });
      }
      const readinessRemainingMs = remainingMs();
      if (readinessRemainingMs !== undefined && readinessRemainingMs <= 0) {
        throw deadlineError();
      }
      await params.waitForReady(
        readinessRemainingMs === undefined
          ? Math.max(10_000, params.timeoutMs)
          : Math.min(Math.max(10_000, params.timeoutMs), readinessRemainingMs),
      );
    }
  }
  throw new Error(`${lastDetails}${formatQaGatewayLogsForError(params.logs())}`);
}

async function fetchLocalGatewayHealth(params: {
  baseUrl: string;
  healthPath: "/readyz" | "/healthz";
  timeoutMs?: number;
}): Promise<boolean> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${params.baseUrl}${params.healthPath}`,
    init: {
      method: "HEAD",
      headers: {
        connection: "close",
      },
      signal: AbortSignal.timeout(params.timeoutMs ?? 2_000),
    },
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-lab-gateway-child-health",
  });
  try {
    return response.ok;
  } finally {
    await release();
  }
}

async function fetchLocalGatewayListening(baseUrl: string): Promise<boolean> {
  const { release } = await fetchWithSsrFGuard({
    url: `${baseUrl}/healthz`,
    init: {
      method: "HEAD",
      headers: {
        connection: "close",
      },
      signal: AbortSignal.timeout(2_000),
    },
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-lab-gateway-child-listening",
  });
  await release();
  return true;
}

export async function waitForQaGatewayRestartBoundary(params: {
  readLogsSince: (mark: number) => string;
  mark: number;
  pollMs?: number;
  timeoutMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? QA_GATEWAY_CHILD_RESTART_BOUNDARY_TIMEOUT_MS;
  const pollMs = resolveTimerTimeoutMs(params.pollMs ?? 100, 100, 0);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (params.readLogsSince(params.mark).includes("restart mode:")) {
      return;
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollMs, remainingMs));
  }
  throw new Error(`qa gateway child did not reach restart boundary within ${timeoutMs}ms`);
}

export async function waitForGatewayReady(params: {
  baseUrl: string;
  logs: () => string;
  child: QaGatewayHealthChild;
  getChildFailure?: () => QaChildFailure | null;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + (params.timeoutMs ?? 60_000);
  let remainingMs: number;
  while ((remainingMs = deadline - Date.now()) > 0) {
    throwQaGatewayChildFailure(params.getChildFailure, params.logs);
    if (hasQaGatewayChildExited(params.child)) {
      throw new QaSuiteInfraError(
        "gateway_startup_unhealthy",
        `gateway exited before becoming healthy (exitCode=${String(params.child.exitCode)}, signal=${String(params.child.signalCode)}):\n${params.logs()}`,
      );
    }
    // Listener liveness can turn green before the Gateway can admit startup or restart work.
    try {
      if (
        await fetchLocalGatewayHealth({
          baseUrl: params.baseUrl,
          healthPath: "/readyz",
          timeoutMs: Math.min(2_000, remainingMs),
        })
      ) {
        return;
      }
    } catch {
      // retry until timeout
    }
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new QaSuiteInfraError(
    "gateway_startup_unhealthy",
    `gateway failed to become healthy:\n${params.logs()}`,
  );
}

export async function waitForGatewayListening(params: {
  baseUrl: string;
  logs: () => string;
  child: QaGatewayHealthChild;
  getChildFailure?: () => QaChildFailure | null;
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < (params.timeoutMs ?? 60_000)) {
    throwQaGatewayChildFailure(params.getChildFailure, params.logs);
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new QaSuiteInfraError(
        "gateway_startup_unhealthy",
        `gateway exited before listening (exitCode=${String(params.child.exitCode)}, signal=${String(params.child.signalCode)}):\n${params.logs()}`,
      );
    }
    try {
      if (await fetchLocalGatewayListening(params.baseUrl)) {
        return;
      }
    } catch {
      // retry until the HTTP listener accepts requests
    }
    await sleep(100);
  }
  throw new QaSuiteInfraError(
    "gateway_startup_unhealthy",
    `gateway failed to listen before timeout:\n${params.logs()}`,
  );
}

export function isRetryableRpcStartupError(error: unknown) {
  const details = formatErrorMessage(error);
  return (
    details.includes("gateway timeout after") ||
    details.includes("handshake timeout") ||
    details.includes("gateway token mismatch") ||
    details.includes("token mismatch") ||
    details.includes("gateway closed (1000") ||
    details.includes("gateway closed (1006") ||
    details.includes("gateway closed (1012)")
  );
}
