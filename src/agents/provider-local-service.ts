import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelProviderLocalServiceConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("provider-local-service");
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const PROBE_INTERVAL_MS = 1_000;

const MODEL_PROVIDER_LOCAL_SERVICE_SYMBOL = Symbol.for("openclaw.modelProviderLocalService");

type ModelWithProviderLocalService = {
  [MODEL_PROVIDER_LOCAL_SERVICE_SYMBOL]?: ModelProviderLocalServiceConfig;
};

type ManagedLocalService = {
  process?: ChildProcess;
  starting?: Promise<void>;
  startupAbort?: AbortController;
  active: number;
  idleTimer?: NodeJS.Timeout;
  lastExit?: LocalServiceExit;
};

const services = new Map<string, ManagedLocalService>();
let exitHandlerInstalled = false;

type LocalServiceExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type ProviderLocalServiceLease = {
  release: () => void;
};

export function attachModelProviderLocalService<TModel extends object>(
  model: TModel,
  service: ModelProviderLocalServiceConfig | undefined,
): TModel {
  if (!service) {
    return model;
  }
  const next = { ...model } as TModel & ModelWithProviderLocalService;
  next[MODEL_PROVIDER_LOCAL_SERVICE_SYMBOL] = service;
  return next;
}

export function getModelProviderLocalService(
  model: object,
): ModelProviderLocalServiceConfig | undefined {
  return (model as ModelWithProviderLocalService)[MODEL_PROVIDER_LOCAL_SERVICE_SYMBOL];
}

export async function ensureModelProviderLocalService(
  model: Model<Api>,
  probeHeaders?: HeadersInit,
  signal?: AbortSignal | null,
): Promise<ProviderLocalServiceLease | undefined> {
  const service = getModelProviderLocalService(model);
  if (!service) {
    return undefined;
  }
  throwIfAborted(signal);

  validateLocalServiceConfig(service, model.provider);
  const healthUrl = resolveHealthUrl(service, model.baseUrl);
  const healthHeaders = buildHealthProbeHeaders(model, probeHeaders);
  const key = localServiceKey(model.provider, service, healthUrl);
  installExitHandler();
  const managed = services.get(key) ?? { active: 0 };
  services.set(key, managed);
  clearIdleTimer(managed);
  managed.active += 1;

  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    managed.active = Math.max(0, managed.active - 1);
    scheduleIdleStop(key, managed, service);
  };

  try {
    if (
      managed.process?.exitCode === null &&
      (await probeHealth(healthUrl, healthHeaders, signal))
    ) {
      return { release };
    }
    if (!managed.starting) {
      const startupAbort = new AbortController();
      managed.startupAbort = startupAbort;
      managed.starting = startAndWaitForLocalService({
        provider: model.provider,
        service,
        healthUrl,
        healthHeaders,
        managed,
        signal: startupAbort.signal,
      }).finally(() => {
        managed.starting = undefined;
        if (managed.startupAbort === startupAbort) {
          managed.startupAbort = undefined;
        }
      });
    }
    await waitForAbort(managed.starting, signal);
    if (!managed.process || managed.process.exitCode !== null) {
      release();
      return undefined;
    }
    return { release };
  } catch (error) {
    const abortingStartup = isAbortForSignal(error, signal) && Boolean(managed.starting);
    release();
    if (isAbortForSignal(error, signal)) {
      if (abortingStartup && managed.active === 0) {
        managed.startupAbort?.abort(toAbortError(signal));
        stopManagedService(key, managed, "startup-aborted");
      }
    } else {
      stopManagedService(key, managed, "startup-failed");
    }
    throw error;
  }
}

export function stopManagedProviderLocalServicesForTest(): void {
  for (const [key, managed] of services) {
    stopManagedService(key, managed, "test");
  }
  services.clear();
}

function validateLocalServiceConfig(service: ModelProviderLocalServiceConfig, provider: string) {
  if (!path.isAbsolute(service.command)) {
    throw new Error(`models.providers.${provider}.localService.command must be an absolute path`);
  }
}

function resolveHealthUrl(service: ModelProviderLocalServiceConfig, baseUrl: string): string {
  const configured = service.healthUrl?.trim();
  if (configured) {
    return configured;
  }
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

function localServiceKey(
  provider: string,
  service: ModelProviderLocalServiceConfig,
  healthUrl: string,
): string {
  return JSON.stringify({
    provider,
    command: service.command,
    args: service.args ?? [],
    cwd: service.cwd ?? "",
    env: sortedStringRecord(service.env),
    healthUrl,
  });
}

function sortedStringRecord(record: Record<string, string> | undefined): Record<string, string> {
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function buildHealthProbeHeaders(
  model: Model<Api>,
  requestHeaders: HeadersInit | undefined,
): Headers | undefined {
  const headers = new Headers();
  const appendHeaders = (input: HeadersInit | undefined) => {
    if (!input) {
      return;
    }
    for (const [key, value] of new Headers(input)) {
      if (value.trim().length > 0 && value.trim().toLowerCase() !== "null") {
        headers.set(key, value);
      }
    }
  };
  appendHeaders((model as { headers?: HeadersInit }).headers);
  appendHeaders(requestHeaders);
  return [...headers].length > 0 ? headers : undefined;
}

async function probeHealth(
  url: string,
  headers: HeadersInit | undefined,
  signal?: AbortSignal | null,
): Promise<boolean> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_PROBE_TIMEOUT_MS);
  timeout.unref?.();
  const onAbort = () => controller.abort(toAbortError(signal));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    return response.ok;
  } catch {
    if (signal?.aborted) {
      throw toAbortError(signal);
    }
    return false;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function startAndWaitForLocalService(params: {
  provider: string;
  service: ModelProviderLocalServiceConfig;
  healthUrl: string;
  healthHeaders: HeadersInit | undefined;
  managed: ManagedLocalService;
  signal: AbortSignal;
}): Promise<void> {
  const { provider, service, healthUrl, healthHeaders, managed, signal } = params;
  if (await probeHealth(healthUrl, healthHeaders, signal)) {
    return;
  }
  if (managed.process?.exitCode === null) {
    log.info(`restarting unhealthy ${provider} local service`);
    await stopManagedProcessForRestart(managed, signal);
  }

  log.info(`starting ${provider} local service: ${service.command}`);
  managed.process = spawn(service.command, service.args ?? [], {
    cwd: service.cwd,
    env: service.env ? { ...process.env, ...service.env } : process.env,
    stdio: "ignore",
  });
  const child = managed.process;
  managed.lastExit = undefined;
  child.unref();
  child.once("exit", (code, signal) => {
    log.info(
      `${provider} local service exited: ${signal ? `signal=${signal}` : `code=${code ?? 0}`}`,
    );
    if (managed.process === child) {
      managed.lastExit = { code, signal };
      managed.process = undefined;
    }
  });
  const spawnError = await waitForSpawnResult(child, signal);
  if (spawnError) {
    throw new Error(`${provider} local service failed to start: ${spawnError.message}`);
  }

  const deadline = Date.now() + (service.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  for (;;) {
    if (await probeHealth(healthUrl, healthHeaders, signal)) {
      log.info(`${provider} local service ready`);
      return;
    }
    if (managed.lastExit) {
      throw new Error(
        `${provider} local service exited before readiness with ${formatLocalServiceExit(
          managed.lastExit,
        )}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`${provider} local service did not become ready at ${healthUrl}`);
    }
    await sleep(PROBE_INTERVAL_MS, signal);
  }
}

function scheduleIdleStop(
  key: string,
  managed: ManagedLocalService,
  service: ModelProviderLocalServiceConfig,
) {
  const idleStopMs = service.idleStopMs ?? 0;
  if (managed.active > 0) {
    return;
  }
  if (!managed.process) {
    if (!managed.starting) {
      services.delete(key);
    }
    return;
  }
  if (idleStopMs <= 0) {
    return;
  }
  managed.idleTimer = setTimeout(() => {
    if (managed.active === 0) {
      stopManagedService(key, managed, "idle");
    }
  }, idleStopMs);
  managed.idleTimer.unref?.();
}

function clearIdleTimer(managed: ManagedLocalService) {
  if (managed.idleTimer) {
    clearTimeout(managed.idleTimer);
    managed.idleTimer = undefined;
  }
}

function stopManagedService(key: string, managed: ManagedLocalService, reason: string) {
  clearIdleTimer(managed);
  managed.startupAbort?.abort(new Error(`local service stopped: ${reason}`));
  managed.startupAbort = undefined;
  const child = managed.process;
  managed.process = undefined;
  managed.lastExit = undefined;
  services.delete(key);
  if (child && child.exitCode === null) {
    log.info(`stopping local model service: reason=${reason}`);
    child.kill("SIGTERM");
  }
}

async function stopManagedProcessForRestart(
  managed: ManagedLocalService,
  signal: AbortSignal,
): Promise<void> {
  const child = managed.process;
  managed.process = undefined;
  managed.lastExit = undefined;
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await waitForChildExit(child, signal, DEFAULT_PROBE_TIMEOUT_MS);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await waitForChildExit(child, signal, DEFAULT_PROBE_TIMEOUT_MS);
  }
}

function formatLocalServiceExit(exit: LocalServiceExit): string {
  return exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 0}`;
}

function installExitHandler() {
  if (exitHandlerInstalled) {
    return;
  }
  exitHandlerInstalled = true;
  process.once("exit", () => {
    for (const [key, managed] of services) {
      stopManagedService(key, managed, "process-exit");
    }
  });
}

function toAbortError(signal?: AbortSignal | null): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw toAbortError(signal);
  }
}

function isAbortForSignal(error: unknown, signal?: AbortSignal | null): boolean {
  return (
    Boolean(signal?.aborted) &&
    (error === signal?.reason || (error instanceof Error && error.name === "AbortError"))
  );
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  throwIfAborted(signal);
  if (!signal) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(toAbortError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(toAbortError(signal));
    };
    timeout = setTimeout(onDone, ms);
    timeout.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForSpawnResult(
  child: ChildProcess,
  signal?: AbortSignal | null,
): Promise<Error | undefined> {
  throwIfAborted(signal);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      child.off("error", onError);
      child.off("spawn", onSpawn);
      signal?.removeEventListener("abort", onAbort);
      resolve(error);
    };
    const onError = (error: Error) => finish(error);
    const onSpawn = () => finish();
    const onAbort = () => finish(toAbortError(signal));
    child.once("error", onError);
    child.once("spawn", onSpawn);
    signal?.addEventListener("abort", onAbort, { once: true });
    setImmediate(() => {
      if (child.pid) {
        finish();
      }
    });
  });
}

function waitForChildExit(
  child: ChildProcess,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onExit = () => finish();
    const onAbort = () => {
      cleanup();
      reject(toAbortError(signal));
    };
    timeout = setTimeout(finish, timeoutMs);
    timeout.unref?.();
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
