import { createServer } from "node:net";
import path from "node:path";
// QA runtime helpers register and execute plugin QA scenarios from local files.
import { runExec } from "./process-runtime.js";
import { loadQaRuntimeModule as loadQaRunnerRuntimeModule } from "./qa-runner-runtime.js";
import { fetchWithSsrFGuard } from "./ssrf-runtime.js";
import { normalizeStringEntries } from "./string-coerce-runtime.js";

export { writeGatewayRestartIntentSync } from "../infra/restart-intent.js";
export {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  runLiveTransportQaSuiteCommand,
} from "./qa-runner-runtime.js";
export type {
  LiveTransportQaCliRegistration,
  LiveTransportQaCliRegistrationOptions,
  LiveTransportQaCommandOptions,
  LiveTransportQaCredentialCliOptions,
  LiveTransportQaSuiteCommandOptions,
} from "./qa-runner-runtime.js";

/** Release only this QA root's parent stores before its files are removed. */
export async function closeQaRuntimeStores(tempRoot: string): Promise<void> {
  const [auth, agents, state, paths] = await Promise.all([
    import("../agents/auth-profiles/sqlite.js"),
    import("../state/openclaw-agent-db.js"),
    import("../state/openclaw-state-db.js"),
    import("../state/openclaw-state-db.paths.js"),
  ]);
  // Agent close releases leases through shared state. Keep that owner alive
  // until every scoped handle closes, or exit-time release can recreate the root.
  auth.closeAuthProfileReadPool({ kind: "root", rootPath: tempRoot });
  agents.closeOpenClawAgentDatabases(tempRoot);
  state.closeOpenClawStateDatabaseByPath(
    paths.resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: path.join(tempRoot, "state") }),
  );
}

type QaRuntimeSurface = {
  acquireQaCredentialLease: <TPayload>(options: {
    env?: NodeJS.ProcessEnv;
    kind: string;
    parsePayload: (payload: unknown) => TPayload;
    resolveEnvPayload: () => TPayload;
    source?: string;
  }) => Promise<{
    heartbeat(): Promise<void>;
    heartbeatIntervalMs: number;
    kind: string;
    payload: TPayload;
    release(): Promise<void>;
    source: "convex" | "env";
  }>;
  defaultQaRuntimeModelForMode: (
    mode: string,
    options?: {
      alternate?: boolean;
      preferredLiveModel?: string;
    },
  ) => string;
  createQaLiveLaneGateway: () => {
    start: (...args: unknown[]) => Promise<unknown>;
    stop: () => Promise<{
      process: "never-spawned" | "confirmed-stopped" | "unconfirmed";
      errors: unknown[];
    }>;
  };
  startQaCredentialLeaseHeartbeat: (lease: {
    heartbeat(): Promise<void>;
    heartbeatIntervalMs: number;
    kind: string;
    source: "convex" | "env";
  }) => {
    stop(): Promise<void>;
    throwIfFailed(): void;
  };
};

function isMissingQaRuntimeError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message === "Unable to resolve bundled plugin public surface qa-lab/runtime-api.js" ||
      error.message.startsWith("Unable to open bundled plugin public surface "))
  );
}

const loadQaLabRuntimeModule = loadQaRunnerRuntimeModule as unknown as () => QaRuntimeSurface;
export { loadQaLabRuntimeModule as loadQaRuntimeModule };

function isQaRuntimeAvailableStrict(): boolean {
  try {
    loadQaLabRuntimeModule();
    return true;
  } catch (error) {
    if (isMissingQaRuntimeError(error)) {
      return false;
    }
    throw error;
  }
}

export { isQaRuntimeAvailableStrict as isQaRuntimeAvailable };

/** Docker command runner abstraction used by QA Docker helpers and tests. */
export type QaDockerRunCommand = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

/** Minimal fetch-like health probe used by QA Docker runtime helpers. */
export type QaDockerFetchResponse = {
  ok: boolean;
  body?: { cancel?: () => unknown } | null;
};
export type QaDockerFetchLike = (
  input: string,
  init?: Pick<RequestInit, "signal">,
) => Promise<QaDockerFetchResponse>;

const DEFAULT_QA_DOCKER_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_QA_DOCKER_HEALTH_REQUEST_TIMEOUT_MS = 2_000;

function describeQaDockerError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

async function isQaDockerPortFree(port: number) {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreeQaDockerPort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to find free port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

/** Return the preferred Docker host port unless it is unpinned and already occupied. */
export async function resolveQaDockerHostPort(preferredPort: number, pinned: boolean) {
  if (pinned || (await isQaDockerPortFree(preferredPort))) {
    return preferredPort;
  }
  return await findFreeQaDockerPort();
}

function trimQaDockerCommandOutput(output: string) {
  const trimmed = output.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed.split("\n");
  return lines.length <= 120 ? trimmed : lines.slice(-120).join("\n");
}

function renderQaDockerCommandFailure(command: string, args: string[], error: unknown) {
  const failedProcess = error as Error & { stdout?: string; stderr?: string };
  const renderedStdout = trimQaDockerCommandOutput(failedProcess.stdout ?? "");
  const renderedStderr = trimQaDockerCommandOutput(failedProcess.stderr ?? "");
  return new Error(
    [
      `Command failed: ${[command, ...args].join(" ")}`,
      renderedStderr ? `stderr:\n${renderedStderr}` : "",
      renderedStdout ? `stdout:\n${renderedStdout}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    { cause: error },
  );
}

function normalizeDockerServiceStatus(row?: { Health?: string; State?: string }) {
  const health = row?.Health?.trim();
  if (health) {
    return health;
  }
  const state = row?.State?.trim();
  if (state) {
    return state;
  }
  return "unknown";
}

function firstDockerOutputLine(stdout: string) {
  return normalizeStringEntries(stdout.split("\n"))[0] ?? "";
}

function parseDockerComposePsRows(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [] as Array<{ Health?: string; State?: string }>;
  }

  try {
    const parsed = JSON.parse(trimmed) as
      | Array<{ Health?: string; State?: string }>
      | { Health?: string; State?: string };
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [parsed];
  } catch {
    return normalizeStringEntries(trimmed.split("\n")).map(
      (line) => JSON.parse(line) as { Health?: string; State?: string },
    );
  }
}

async function isQaDockerHealthy(
  url: string,
  fetchImpl: QaDockerFetchLike,
  timeoutMs = DEFAULT_QA_DOCKER_HEALTH_REQUEST_TIMEOUT_MS,
) {
  let response: QaDockerFetchResponse | undefined;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    await releaseQaDockerFetchResponse(response);
  }
}

async function releaseQaDockerFetchResponse(response: QaDockerFetchResponse | undefined) {
  try {
    await response?.body?.cancel?.();
  } catch {}
}

/** Create Docker command, health-check, and compose helpers for QA harnesses. */
export function createQaDockerRuntime(params: {
  auditContext: string;
  commandTimeoutMs?: number | null;
}) {
  const commandTimeoutMs =
    params.commandTimeoutMs === undefined
      ? DEFAULT_QA_DOCKER_COMMAND_TIMEOUT_MS
      : params.commandTimeoutMs;

  const fetchHealthUrl: QaDockerFetchLike = async (url, init) => {
    const { response, release } = await fetchWithSsrFGuard({
      url,
      signal: init?.signal ?? undefined,
      timeoutMs: DEFAULT_QA_DOCKER_HEALTH_REQUEST_TIMEOUT_MS,
      policy: { allowPrivateNetwork: true },
      auditContext: params.auditContext,
    });
    try {
      return { ok: response.ok };
    } finally {
      await releaseQaDockerFetchResponse(response);
      await release();
    }
  };

  const execCommand: QaDockerRunCommand = async (command, args, cwd) => {
    try {
      return await runExec(command, args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        ...(commandTimeoutMs === null ? {} : { timeoutMs: commandTimeoutMs }),
      });
    } catch (error) {
      throw renderQaDockerCommandFailure(command, args, error);
    }
  };

  const waitForHealth = async (
    url: string,
    deps: {
      label?: string;
      composeFile?: string;
      fetchImpl: QaDockerFetchLike;
      sleepImpl: (ms: number) => Promise<unknown>;
      timeoutMs?: number;
      pollMs?: number;
    },
  ) => {
    const timeoutMs = deps.timeoutMs ?? 360_000;
    const pollMs = deps.pollMs ?? 1_000;
    const startMs = Date.now();
    const deadline = startMs + timeoutMs;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      let response: QaDockerFetchResponse | undefined;
      const requestTimeoutMs = Math.max(
        1,
        Math.min(DEFAULT_QA_DOCKER_HEALTH_REQUEST_TIMEOUT_MS, remainingMs),
      );
      const requestSignal = AbortSignal.timeout(requestTimeoutMs);
      try {
        response = await deps.fetchImpl(url, {
          signal: requestSignal,
        });
        if (response.ok) {
          return;
        }
        lastError = new Error(`Health check returned non-OK for ${url}`);
      } catch (error) {
        lastError = error;
        if (requestSignal.aborted && requestTimeoutMs === remainingMs) {
          break;
        }
      } finally {
        await releaseQaDockerFetchResponse(response);
      }
      const remainingSleepMs = deadline - Date.now();
      if (remainingSleepMs > 0) {
        await deps.sleepImpl(Math.min(pollMs, remainingSleepMs));
      }
    }

    const elapsedSec = Math.round((Date.now() - startMs) / 1000);
    const service = deps.label ?? url;
    const lines = [
      `${service} did not become healthy within ${elapsedSec}s (limit ${Math.round(timeoutMs / 1000)}s).`,
      lastError ? `Last error: ${describeQaDockerError(lastError)}` : "",
      `Hint: check container logs with \`docker compose -f ${deps.composeFile ?? "<compose-file>"} logs\` and verify the port is not already in use.`,
    ];
    throw new Error(lines.filter(Boolean).join("\n"));
  };

  const waitForDockerServiceHealth = async (
    service: string,
    composeFile: string,
    repoRoot: string,
    runCommand: QaDockerRunCommand,
    sleepImpl: (ms: number) => Promise<unknown>,
    timeoutMs = 360_000,
    pollMs = 1_000,
  ) => {
    const startMs = Date.now();
    const deadline = startMs + timeoutMs;
    let lastStatus = "unknown";

    while (Date.now() < deadline) {
      try {
        const { stdout } = await runCommand(
          "docker",
          ["compose", "-f", composeFile, "ps", "--format", "json", service],
          repoRoot,
        );
        const row = parseDockerComposePsRows(stdout)[0];
        lastStatus = normalizeDockerServiceStatus(row);
        if (lastStatus === "healthy" || lastStatus === "running") {
          return;
        }
      } catch (error) {
        lastStatus = describeQaDockerError(error);
      }
      await sleepImpl(pollMs);
    }

    const elapsedSec = Math.round((Date.now() - startMs) / 1000);
    throw new Error(
      [
        `${service} did not become healthy within ${elapsedSec}s (limit ${Math.round(timeoutMs / 1000)}s).`,
        `Last status: ${lastStatus}`,
        `Hint: check container logs with \`docker compose -f ${composeFile} logs ${service}\`.`,
      ].join("\n"),
    );
  };

  const resolveComposeServiceUrl = async (
    service: string,
    port: number,
    composeFile: string,
    repoRoot: string,
    runCommand: QaDockerRunCommand,
    fetchImpl?: QaDockerFetchLike,
  ) => {
    const { stdout: containerStdout } = await runCommand(
      "docker",
      ["compose", "-f", composeFile, "ps", "-q", service],
      repoRoot,
    );
    const containerId = firstDockerOutputLine(containerStdout);
    if (!containerId) {
      return null;
    }
    const { stdout: ipStdout } = await runCommand(
      "docker",
      [
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}",
        containerId,
      ],
      repoRoot,
    );
    const ip = firstDockerOutputLine(ipStdout);
    if (!ip) {
      return null;
    }
    const baseUrl = `http://${ip}:${port}/`;
    if (!fetchImpl) {
      return baseUrl;
    }
    return (await isQaDockerHealthy(`${baseUrl}healthz`, fetchImpl)) ? baseUrl : null;
  };

  return {
    execCommand,
    fetchHealthUrl,
    resolveComposeServiceUrl,
    resolveHostPort: resolveQaDockerHostPort,
    waitForDockerServiceHealth,
    waitForHealth,
  };
}
