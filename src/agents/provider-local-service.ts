/**
 * Manages optional local provider sidecar processes attached to models. Leases
 * keep shared services alive while requests run and stop them after idle.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  clampPositiveTimerTimeoutMs,
  resolvePositiveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import type { ModelProviderLocalServiceConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toErrorObject } from "../infra/errors.js";
import type { Model } from "../llm/types.js";
import { isSensitiveFieldKey, redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  forceKillChildProcessTree,
  signalChildProcessTree,
  shouldDetachChildForProcessTree,
} from "../process/child-process-tree.js";
import { unwrapHeadersInitSentinelsForProviderEgress } from "./provider-secret-egress.js";

const log = createSubsystemLogger("provider-local-service");
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const PROBE_INTERVAL_MS = 250;
const LOCAL_SERVICE_OUTPUT_TAIL_MAX_BYTES = 8 * 1024;

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
  diagnostics?: LocalServiceDiagnostics;
};

const services = new Map<string, ManagedLocalService>();
let exitHandlerInstalled = false;

type LocalServiceExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type LocalServiceDiagnostics = {
  providerId: string;
  healthUrl: string;
  pid?: number;
  startedAt: number;
  spawnedAt?: number;
  readyAt?: number;
  lastHealthyAt?: number;
  stdoutTail: string;
  stderrTail: string;
  lastExit?: LocalServiceExit;
};

/** Exact provider endpoint whose optional local process should be leased. */
export type ProviderLocalServiceTarget = {
  providerId: string;
  baseUrl: string;
  headers?: HeadersInit;
  service?: ModelProviderLocalServiceConfig;
};

/** Configured provider endpoint whose host-owned local service may be leased. */
export type ConfiguredProviderLocalServiceTarget = Omit<ProviderLocalServiceTarget, "service">;

/** Lease returned for a started or already-running local provider service. */
export type ProviderLocalServiceLease = {
  release: () => void;
};

/** Host-injected acquisition hook that cannot supply process configuration. */
export type AcquireConfiguredProviderLocalService = (
  target: ConfiguredProviderLocalServiceTarget,
  signal?: AbortSignal | null,
) => Promise<ProviderLocalServiceLease | undefined>;

/** Bind local-service acquisition to a host-owned config snapshot. */
export function createConfiguredProviderLocalServiceAcquirer(
  getConfig: () => OpenClawConfig,
): AcquireConfiguredProviderLocalService {
  return async (target, signal) => {
    const provider = getConfig().models?.providers?.[target.providerId];
    const service = provider?.localService;
    if (!service) {
      return undefined;
    }
    if (!isConfiguredProviderBaseUrl(target.baseUrl, readConfiguredProviderBaseUrl(provider))) {
      throw new Error(
        `Local service target must match models.providers.${target.providerId}.baseUrl`,
      );
    }
    return await ensureProviderLocalService({ ...target, service }, signal);
  };
}

function readConfiguredProviderBaseUrl(
  provider: { baseUrl?: string; baseURL?: unknown } | undefined,
): string | undefined {
  const canonical = provider?.baseUrl?.trim();
  if (canonical) {
    return canonical;
  }
  const alternate = provider?.baseURL;
  return typeof alternate === "string" && alternate.trim() ? alternate.trim() : undefined;
}

function normalizeProviderBaseUrl(value: string): string | undefined {
  const trimmed = value.trim();
  const candidates = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? [trimmed] : [`http://${trimmed}`];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        continue;
      }
      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
      return url.toString().replace(/\/$/u, "");
    } catch {
      continue;
    }
  }
  return undefined;
}

function configuredProviderBaseUrlVariants(value: string): Set<string> {
  const normalized = normalizeProviderBaseUrl(value);
  if (!normalized) {
    return new Set();
  }
  const withoutOpenAiPath = normalized.replace(/\/v1$/iu, "");
  return new Set([normalized, withoutOpenAiPath, `${withoutOpenAiPath}/v1`]);
}

function isLoopbackProviderBaseUrl(value: string): boolean {
  const normalized = normalizeProviderBaseUrl(value);
  if (!normalized) {
    return false;
  }
  const hostname = new URL(normalized).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isConfiguredProviderBaseUrl(targetBaseUrl: string, configuredBaseUrl?: string): boolean {
  const target = normalizeProviderBaseUrl(targetBaseUrl);
  if (!target) {
    return false;
  }
  const configured = configuredBaseUrl?.trim();
  return configured
    ? configuredProviderBaseUrlVariants(configured).has(target)
    : isLoopbackProviderBaseUrl(target);
}

/** Attach local-service startup metadata to a model without mutating the original object. */
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

/** Read local-service startup metadata attached to a model. */
export function getModelProviderLocalService(
  model: object,
): ModelProviderLocalServiceConfig | undefined {
  return (model as ModelWithProviderLocalService)[MODEL_PROVIDER_LOCAL_SERVICE_SYMBOL];
}

/** Ensure a model's local provider service is healthy and return a lease. */
export async function ensureModelProviderLocalService(
  model: Model,
  probeHeaders?: HeadersInit,
  signal?: AbortSignal | null,
): Promise<ProviderLocalServiceLease | undefined> {
  const service = getModelProviderLocalService(model);
  return await ensureProviderLocalService(
    {
      providerId: model.provider,
      baseUrl: model.baseUrl,
      headers: buildHealthProbeHeaders((model as { headers?: HeadersInit }).headers, probeHeaders),
      service,
    },
    signal,
  );
}

/** Ensure a provider endpoint's local service is healthy and return a request lease. */
export async function ensureProviderLocalService(
  target: ProviderLocalServiceTarget,
  signal?: AbortSignal | null,
): Promise<ProviderLocalServiceLease | undefined> {
  const service = target.service;
  if (!service) {
    return undefined;
  }
  throwIfAborted(signal);

  validateLocalServiceConfig(service, target.providerId);
  const healthUrl = resolveHealthUrl(service, target.baseUrl);
  const healthHeaders = buildHealthProbeHeaders(target.headers, undefined);
  const key = localServiceKey(target.providerId, service, healthUrl);
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
      managed.process &&
      !hasLocalServiceProcessExited(managed.process) &&
      (await probeHealth(healthUrl, healthHeaders, signal))
    ) {
      return { release };
    }
    if (!managed.starting) {
      // Concurrent callers share one startup promise for the same service key.
      const startupAbort = new AbortController();
      managed.startupAbort = startupAbort;
      managed.starting = startAndWaitForLocalService({
        provider: target.providerId,
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
    if (!managed.process || hasLocalServiceProcessExited(managed.process)) {
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

/** Stop all managed local services and clear process state for tests. */
export function stopManagedProviderLocalServicesForTest(): void {
  for (const [key, managed] of services) {
    stopManagedService(key, managed, "test");
  }
  services.clear();
}

/** Return bounded local-service state for focused lifecycle tests. */
export function getManagedProviderLocalServiceDiagnosticsForTest(): LocalServiceDiagnostics[] {
  return structuredClone(
    [...services.values()]
      .map((managed) => managed.diagnostics)
      .filter((value): value is LocalServiceDiagnostics => value !== undefined),
  );
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
    envHash: hashStringRecord(service.env),
    healthUrl,
  });
}

function hashStringRecord(record: Record<string, string> | undefined): string {
  const sorted = Object.entries(record ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function buildHealthProbeHeaders(
  providerHeaders: HeadersInit | undefined,
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
  appendHeaders(providerHeaders);
  appendHeaders(requestHeaders);
  return [...headers].length > 0 ? headers : undefined;
}

async function probeHealth(
  url: string,
  headers: HeadersInit | undefined,
  signal?: AbortSignal | null,
): Promise<boolean> {
  throwIfAborted(signal);
  // Local-service orchestration retains sentinel headers across retries. Only
  // the actual health request may materialize credentials.
  const egressHeaders = unwrapHeadersInitSentinelsForProviderEgress(
    headers,
    "to probe local model provider health",
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_PROBE_TIMEOUT_MS);
  timeout.unref?.();
  const onAbort = () => controller.abort(toAbortError(signal));
  signal?.addEventListener("abort", onAbort, { once: true });
  let response: Response | undefined;
  try {
    response = await fetch(url, { headers: egressHeaders, signal: controller.signal });
    return response.ok;
  } catch {
    if (signal?.aborted) {
      throw toAbortError(signal);
    }
    return false;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    await response?.body?.cancel?.().catch(() => undefined);
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
  if (managed.process && !hasLocalServiceProcessExited(managed.process)) {
    log.info(`restarting unhealthy ${provider} local service`);
    await stopManagedProcessForRestart(managed, signal);
  }

  const startedAt = Date.now();
  const diagnostics: LocalServiceDiagnostics = {
    providerId: provider,
    healthUrl,
    startedAt,
    stdoutTail: "",
    stderrTail: "",
  };
  managed.diagnostics = diagnostics;
  // The last lease can disappear while the health probe or restart settles.
  // Recheck at the spawn boundary so cleanup cannot orphan a newly created child.
  throwIfAborted(signal);
  log.info(`starting ${provider} local service: ${service.command}`);
  managed.process = spawn(service.command, service.args ?? [], {
    cwd: service.cwd,
    env: service.env ? { ...process.env, ...service.env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: shouldDetachChildForProcessTree(),
  });
  const child = managed.process;
  diagnostics.pid = child.pid;
  managed.lastExit = undefined;
  const captureStdout = (chunk: Buffer | string) => {
    diagnostics.stdoutTail = appendLocalServiceOutputTail(
      diagnostics.stdoutTail,
      chunk,
      service.env,
      process.env,
      service.args,
      healthHeaders,
    );
  };
  const captureStderr = (chunk: Buffer | string) => {
    diagnostics.stderrTail = appendLocalServiceOutputTail(
      diagnostics.stderrTail,
      chunk,
      service.env,
      process.env,
      service.args,
      healthHeaders,
    );
  };
  child.stdout?.on("data", captureStdout);
  child.stderr?.on("data", captureStderr);
  child.unref();
  child.once("exit", (code, signalLocal) => {
    const exit = { code, signal: signalLocal };
    diagnostics.lastExit = exit;
    log.info(
      `${provider} local service exited: ${signalLocal ? `signal=${signalLocal}` : `code=${code ?? 0}`}`,
    );
    if (managed.process === child) {
      managed.lastExit = exit;
      managed.process = undefined;
    }
  });
  const spawnError = await waitForSpawnResult(child, signal);
  if (spawnError) {
    throw new Error(
      `${provider} local service failed to start: ${spawnError.message}${formatLocalServiceDiagnosticTail(diagnostics)}`,
    );
  }
  diagnostics.spawnedAt = Date.now();

  const readyTimeoutMs = resolvePositiveTimerTimeoutMs(
    service.readyTimeoutMs,
    DEFAULT_READY_TIMEOUT_MS,
  );
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (await probeHealth(healthUrl, healthHeaders, signal)) {
      diagnostics.readyAt = Date.now();
      diagnostics.lastHealthyAt = diagnostics.readyAt;
      // Pipes keep startup alive while readiness is pending, then stop
      // diagnostics from retaining runtime output or pinning one-shot hosts.
      diagnostics.stdoutTail = "";
      diagnostics.stderrTail = "";
      drainLocalServiceOutput(child);
      log.info(
        `${provider} local service ready: pid=${diagnostics.pid ?? "unknown"} spawnMs=${diagnostics.spawnedAt - startedAt} readyMs=${diagnostics.readyAt - startedAt}`,
      );
      return;
    }
    if (managed.lastExit) {
      throw new Error(
        `${provider} local service exited before readiness with ${formatLocalServiceExit(
          managed.lastExit,
        )}${formatLocalServiceDiagnosticTail(diagnostics)}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`${provider} local service did not become ready at ${healthUrl}`);
    }
    await sleep(PROBE_INTERVAL_MS, signal);
  }
}

function appendLocalServiceOutputTail(
  current: string,
  chunk: Buffer | string,
  serviceEnv: Record<string, string> | undefined,
  inheritedEnv: NodeJS.ProcessEnv,
  serviceArgs: string[] | undefined,
  healthHeaders: HeadersInit | undefined,
): string {
  let redacted = redactSensitiveText(`${current}${chunk.toString()}`, { mode: "tools" });
  for (const value of Object.values(serviceEnv ?? {})) {
    if (value) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
  }
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (value && isSensitiveFieldKey(key)) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
  }
  for (const value of serviceArgs ?? []) {
    if (value) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
  }
  for (const [, value] of new Headers(healthHeaders)) {
    if (value) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
  }
  const bytes = Buffer.from(redacted);
  if (bytes.byteLength <= LOCAL_SERVICE_OUTPUT_TAIL_MAX_BYTES) {
    return redacted;
  }
  let start = bytes.byteLength - LOCAL_SERVICE_OUTPUT_TAIL_MAX_BYTES;
  while (start < bytes.byteLength) {
    const byte = bytes.at(start);
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}

function unrefLocalServiceOutput(stream: ChildProcess["stdout"]): void {
  (stream as { unref?: () => void } | null)?.unref?.();
}

function drainLocalServiceOutput(child: ChildProcess): void {
  child.stdout?.removeAllListeners("data");
  child.stderr?.removeAllListeners("data");
  child.stdout?.resume();
  child.stderr?.resume();
  unrefLocalServiceOutput(child.stdout);
  unrefLocalServiceOutput(child.stderr);
}

function formatLocalServiceDiagnosticTail(diagnostics: LocalServiceDiagnostics): string {
  return diagnostics.stderrTail ? `; stderr: ${diagnostics.stderrTail}` : "";
}

function scheduleIdleStop(
  key: string,
  managed: ManagedLocalService,
  service: ModelProviderLocalServiceConfig,
) {
  const idleStopMs = clampPositiveTimerTimeoutMs(service.idleStopMs);
  if (managed.active > 0) {
    return;
  }
  if (!managed.process) {
    if (!managed.starting) {
      services.delete(key);
    }
    return;
  }
  if (idleStopMs === undefined) {
    return;
  }
  // Services without idleStopMs remain running until process exit or test cleanup.
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
  if (child) {
    drainLocalServiceOutput(child);
  }
  if (child && !hasLocalServiceProcessExited(child)) {
    log.info(`stopping local model service: reason=${reason}`);
    signalChildProcessTree(child, "SIGTERM");
  }
}

async function stopManagedProcessForRestart(
  managed: ManagedLocalService,
  signal: AbortSignal,
): Promise<void> {
  const child = managed.process;
  managed.process = undefined;
  managed.lastExit = undefined;
  if (!child || hasLocalServiceProcessExited(child)) {
    return;
  }
  drainLocalServiceOutput(child);
  signalChildProcessTree(child, "SIGTERM");
  await waitForChildExit(child, signal, DEFAULT_PROBE_TIMEOUT_MS);
  if (!hasLocalServiceProcessExited(child)) {
    forceKillChildProcessTree(child);
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
        reject(toErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
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
    const timeout: NodeJS.Timeout = setTimeout(onDone, ms);
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
  if (hasLocalServiceProcessExited(child)) {
    return Promise.resolve();
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
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
    const timeout: NodeJS.Timeout = setTimeout(finish, timeoutMs);
    timeout.unref?.();
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Return whether a child process has already reported an exit code or signal. */
export function hasLocalServiceProcessExited(
  child: Pick<ChildProcess, "exitCode" | "signalCode">,
): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
