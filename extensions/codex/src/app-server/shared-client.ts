/**
 * Owns shared and isolated Codex app-server client startup, auth application,
 * lease tracking, and teardown.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentHarnessRuntimeArtifactBinding } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveDefaultAgentDir, type AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore,
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerHomeDir,
} from "./auth-bridge.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { CodexAppServerClient, isUnsupportedCodexAppServerVersionError } from "./client.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
  resolveCodexAppServerUserHomeDir,
  type CodexAppServerStartOptions,
} from "./config.js";
import {
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
} from "./managed-binary.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import { withTimeout } from "./timeout.js";

type SharedCodexAppServerClientEntry = {
  client?: CodexAppServerClient;
  startup?: SharedCodexAppServerClientStartup;
  activeLeases: number;
  pendingAcquires: number;
  closeWhenIdle: boolean;
  closeError?: Error;
  runtimeArtifactStartupAbort?: AbortController;
  onStartedClientCallbacks: Set<(client: CodexAppServerClient) => void>;
};

type SharedCodexAppServerClientStartup = {
  initialized: Promise<void>;
  ready: Promise<CodexAppServerClient>;
};

type SharedCodexAppServerClientState = {
  clients: Map<string, SharedCodexAppServerClientEntry>;
  leasedReleases: WeakMap<CodexAppServerClient, Array<() => void>>;
};

type CodexAppServerClientStartMetadata = {
  requestedStartOptions: CodexAppServerStartOptions;
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  nativeCommand?: string;
};

/** Successful physical process identity, excluding environment and credentials. */
export type CodexAppServerClientProcessIdentity = {
  clientId: string;
  command: string;
  argsFingerprint: string;
  commandSource?: CodexAppServerStartOptions["commandSource"];
  managedCommandOrder?: CodexAppServerStartOptions["managedCommandOrder"];
  nativeCommand?: string;
  serverVersion?: string;
  userAgent?: string;
};

export type CodexAppServerSpawnIdentity = Omit<
  CodexAppServerClientProcessIdentity,
  "clientId" | "serverVersion" | "userAgent"
>;

// Clients we already force-closed for suspect retirement; a repeat retire must
// report closed:false instead of pretending to close the corpse again.
const suspectClosedClients = new WeakSet<CodexAppServerClient>();

// Symbol.for shares one client table across duplicate module copies (dist +
// src bundles in one process). Plugin updates restart the gateway, so every
// copy writing this state runs the same code and the shape never migrates.
const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");
const CODEX_APP_SERVER_CLIENT_START_METADATA = Symbol.for(
  "openclaw.codexAppServerClientStartMetadata",
);

function getSharedCodexAppServerClientState(): SharedCodexAppServerClientState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_STATE]?: SharedCodexAppServerClientState;
  };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] ??= {
    clients: new Map(),
    leasedReleases: new WeakMap(),
  };
  return globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE];
}

function getCodexAppServerClientStartMetadata(): WeakMap<
  CodexAppServerClient,
  CodexAppServerClientStartMetadata
> {
  const globalState = globalThis as typeof globalThis & {
    [CODEX_APP_SERVER_CLIENT_START_METADATA]?: WeakMap<
      CodexAppServerClient,
      CodexAppServerClientStartMetadata
    >;
  };
  globalState[CODEX_APP_SERVER_CLIENT_START_METADATA] ??= new WeakMap();
  return globalState[CODEX_APP_SERVER_CLIENT_START_METADATA];
}

/** Reads the exact successful spawn selection plus its initialized runtime identity. */
export function readCodexAppServerClientProcessIdentity(
  client: CodexAppServerClient,
): CodexAppServerClientProcessIdentity | undefined {
  const metadata = getCodexAppServerClientStartMetadata().get(client);
  if (!metadata) {
    return undefined;
  }
  const runtimeIdentity = client.getRuntimeIdentity();
  return {
    clientId: client.getInstanceId(),
    ...resolveCodexAppServerSpawnIdentity(metadata.startOptions, metadata.nativeCommand),
    ...(runtimeIdentity?.serverVersion ? { serverVersion: runtimeIdentity.serverVersion } : {}),
    ...(runtimeIdentity?.userAgent ? { userAgent: runtimeIdentity.userAgent } : {}),
  };
}

/** Resolves non-secret spawn identity before startup; argv is represented only by its hash. */
export function resolveCodexAppServerSpawnIdentity(
  startOptions: CodexAppServerStartOptions,
  resolvedNativeCommand?: string,
): CodexAppServerSpawnIdentity {
  const nativeCommand =
    resolvedNativeCommand ??
    (startOptions.commandSource === "resolved-managed"
      ? resolveManagedCodexNativeCommand(startOptions.command)
      : undefined);
  return {
    command: startOptions.command,
    argsFingerprint: createHash("sha256").update(JSON.stringify(startOptions.args)).digest("hex"),
    ...(startOptions.commandSource ? { commandSource: startOptions.commandSource } : {}),
    ...(startOptions.managedCommandOrder
      ? { managedCommandOrder: startOptions.managedCommandOrder }
      : {}),
    ...(nativeCommand ? { nativeCommand } : {}),
  };
}

export class CodexAppServerStartSelectionChangedError extends Error {
  readonly code = "CODEX_APP_SERVER_START_SELECTION_CHANGED";

  constructor() {
    super("Codex app-server managed executable selection changed during startup");
    this.name = "CodexAppServerStartSelectionChangedError";
  }
}

/** Cross-bundle-safe check for a managed executable selection retry. */
export function isCodexAppServerStartSelectionChangedError(
  error: unknown,
): error is CodexAppServerStartSelectionChangedError {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_START_SELECTION_CHANGED"
  );
}

/**
 * Rechecks mutable Codex-owned plugin state immediately before thread start/resume.
 * The synchronous check prevents another gateway task from installing Computer
 * Use between the check and the JSON-RPC write on the same event loop turn.
 */
export function assertCodexAppServerClientStartSelectionCurrent(params: {
  client: CodexAppServerClient;
  startOptions?: CodexAppServerStartOptions;
  agentDir?: string;
}): void {
  const metadata = getCodexAppServerClientStartMetadata().get(params.client);
  if (!metadata) {
    return;
  }
  const requestedStartOptions = params.startOptions ?? metadata.requestedStartOptions;
  if (requestedStartOptions.commandSource !== "managed") {
    return;
  }
  const current = resolveCodexAppServerStartOptionsForAgent({
    startOptions: requestedStartOptions,
    agentDir: params.agentDir ?? metadata.agentDir,
  });
  const actualOrder = metadata.startOptions.managedCommandOrder ?? "package-first";
  const currentOrder = current.managedCommandOrder ?? "package-first";
  if (actualOrder !== currentOrder) {
    throw new CodexAppServerStartSelectionChangedError();
  }
}

/** Resolves the per-CODEX_HOME key used to serialize native config loading. */
export function resolveCodexNativeConfigFenceKey(params: {
  client?: CodexAppServerClient;
  startOptions?: CodexAppServerStartOptions;
  agentDir?: string;
  config?: CodexAppServerClientOptions["config"];
}): string | undefined {
  const metadata = params.client
    ? getCodexAppServerClientStartMetadata().get(params.client)
    : undefined;
  const startOptions = params.startOptions ?? metadata?.startOptions;
  if (!startOptions || startOptions.transport !== "stdio") {
    return undefined;
  }
  const configuredHome = startOptions.env?.CODEX_HOME?.trim();
  const agentDir =
    params.agentDir ?? metadata?.agentDir ?? resolveDefaultAgentDir(params.config ?? {});
  const codexHome = configuredHome
    ? configuredHome
    : startOptions.homeScope === "user"
      ? resolveCodexAppServerUserHomeDir()
      : agentDir
        ? resolveCodexAppServerHomeDir(agentDir)
        : undefined;
  return codexHome ? `codex-home:${path.resolve(codexHome)}` : undefined;
}

export type CodexAppServerClientOptions = {
  startOptions?: CodexAppServerStartOptions;
  pluginConfig?: unknown;
  timeoutMs?: number;
  authProfileId?: string | null;
  authProfileStore?: AuthProfileStore;
  authBindingFingerprint?: string;
  /** Setup-only generation whose exact local runtime bytes are captured. */
  runtimeArtifactMode?: "capture";
  /** Previously minted exact runtime required before the process may start. */
  expectedRuntimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  onStartedClient?: (client: CodexAppServerClient) => void;
  abandonSignal?: AbortSignal;
};

/** Factory used by attempt startup and side turns to acquire a leased client. */
export type CodexAppServerClientFactory = (
  options?: CodexAppServerClientOptions,
) => Promise<CodexAppServerClient>;

type ResolvedCodexAppServerClientStartContext = {
  agentDir: string;
  usesNativeAuth: boolean;
  authProfileId: string | undefined;
  authProfileStore: AuthProfileStore | undefined;
  requestedStartOptions: CodexAppServerStartOptions;
  startOptions: CodexAppServerStartOptions;
};

async function resolveCodexAppServerClientStartContext(
  options?: CodexAppServerClientOptions,
): Promise<ResolvedCodexAppServerClientStartContext> {
  const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const usesNativeAuth =
    options?.authProfileId === null || requestedStartOptions.homeScope === "user";
  const requestedAuthProfileId =
    options?.authProfileId === null ? undefined : options?.authProfileId;
  const authProfileStore =
    !usesNativeAuth && options?.authProfileStore
      ? resolveCodexAppServerAuthProfileStore({
          agentDir,
          authProfileId: requestedAuthProfileId,
          authProfileStore: options.authProfileStore,
          config: options.config,
        })
      : options?.authProfileStore;
  const authProfileId = usesNativeAuth
    ? undefined
    : resolveCodexAppServerAuthProfileIdForAgent({
        authProfileId: requestedAuthProfileId,
        agentDir,
        config: options?.config,
        ...(authProfileStore ? { authProfileStore } : {}),
      });
  const agentStartOptions = resolveCodexAppServerStartOptionsForAgent({
    startOptions: requestedStartOptions,
    agentDir,
  });
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(agentStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: usesNativeAuth ? null : authProfileId,
    config: options?.config,
    pluginConfig: options?.pluginConfig,
    ...(authProfileStore ? { authProfileStore } : {}),
  });
  return {
    agentDir,
    usesNativeAuth,
    authProfileId,
    authProfileStore,
    requestedStartOptions,
    startOptions,
  };
}

/** Gets or starts a shared Codex app-server client without retaining a lease. */
export async function getSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  return (await acquireSharedCodexAppServerClient(options)).client;
}

/** Gets or starts a shared Codex app-server client and records a release lease. */
export async function getLeasedSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  const acquired = await acquireSharedCodexAppServerClient(options, { leased: true });
  const state = getSharedCodexAppServerClientState();
  const releases = state.leasedReleases.get(acquired.client) ?? [];
  releases.push(acquired.release);
  state.leasedReleases.set(acquired.client, releases);
  return acquired.client;
}

/** Releases one outstanding lease for a shared Codex app-server client. */
export function releaseLeasedSharedCodexAppServerClient(client: CodexAppServerClient): boolean {
  const state = getSharedCodexAppServerClientState();
  const releases = state.leasedReleases.get(client);
  if (!releases) {
    return false;
  }
  const release = releases.pop();
  if (!release) {
    return false;
  }
  if (releases.length === 0) {
    state.leasedReleases.delete(client);
  }
  release();
  return true;
}

/** Mutable ownership token for one shared-client lease across client replacement. */
export type CodexAppServerClientLease = { client?: CodexAppServerClient };

/** Releases the currently owned client exactly once. */
export function releaseCodexAppServerClientLease(lease: CodexAppServerClientLease): boolean {
  const client = lease.client;
  lease.client = undefined;
  return client ? releaseLeasedSharedCodexAppServerClient(client) : false;
}

/** Retries one config-loading request after moving its lease to the current owner. */
export async function withLeasedCodexAppServerClientStartSelectionRetry<T>(params: {
  lease: CodexAppServerClientLease;
  options?: CodexAppServerClientOptions;
  signal?: AbortSignal;
  run: (
    client: CodexAppServerClient,
    requestOptions: { timeoutMs: number; signal?: AbortSignal },
  ) => Promise<T>;
  onClientChange: (client: CodexAppServerClient) => void;
}): Promise<T> {
  let client = params.lease.client;
  if (!client) {
    throw new Error("Codex app-server selection retry requires an active client lease");
  }
  const timeoutMs = params.options?.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const signal = params.signal ?? params.options?.abandonSignal;
  const requestOptions = () => {
    if (signal?.aborted) {
      throw new Error("Codex app-server selection retry aborted");
    }
    const remainingTimeoutMs = deadline - Date.now();
    if (remainingTimeoutMs <= 0) {
      throw new Error("Codex app-server selection retry timed out");
    }
    return {
      timeoutMs: remainingTimeoutMs,
      ...(signal ? { signal } : {}),
    };
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await params.run(client, requestOptions());
    } catch (error) {
      if (!isCodexAppServerStartSelectionChangedError(error) || attempt > 0) {
        throw error;
      }
      // Existing loaded threads can drain safely; only future acquisitions must
      // move to the newly selected desktop-first owner.
      retireSharedCodexAppServerClientIfCurrent(client);
      params.lease.client = undefined;
      if (!releaseLeasedSharedCodexAppServerClient(client)) {
        client.close();
        throw new Error("Codex app-server selection retry requires a leased shared client", {
          cause: error,
        });
      }
      const replacementOptions = requestOptions();
      client = await getLeasedSharedCodexAppServerClient({
        ...params.options,
        timeoutMs: replacementOptions.timeoutMs,
        ...(signal ? { abandonSignal: signal } : {}),
      });
      params.lease.client = client;
      params.onClientChange(client);
    }
  }
  throw new Error("Codex app-server selection retry loop exited unexpectedly");
}

async function acquireSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<{ client: CodexAppServerClient }>;
async function acquireSharedCodexAppServerClient(
  options: CodexAppServerClientOptions | undefined,
  leaseOptions: { leased: true },
): Promise<{ client: CodexAppServerClient; release: () => void }>;
async function acquireSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
  leaseOptions?: { leased: true },
): Promise<{ client: CodexAppServerClient; release?: () => void }> {
  if (options?.abandonSignal?.aborted) {
    throw new Error("codex app-server initialize aborted");
  }
  const acquireStartedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 0;
  const context = await withCodexAppServerAcquireDeadline(
    resolveCodexAppServerClientStartContext(options),
    timeoutMs,
    options?.abandonSignal,
  );
  const {
    agentDir,
    usesNativeAuth,
    authProfileId,
    authProfileStore,
    requestedStartOptions,
    startOptions,
  } = context;
  const remainingTimeoutMs = resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt);
  const fallbackApiKeyCacheKey = authProfileId
    ? undefined
    : resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions });
  const baseKey = codexAppServerStartOptionsKey(startOptions, {
    authProfileId,
    authBindingFingerprint: options?.authBindingFingerprint,
    agentDir: usesNativeAuth ? undefined : agentDir,
    fallbackApiKeyCacheKey,
  });
  // Capture turns cannot inherit a normal client whose loaded bytes predate the
  // filesystem snapshot. Keep their physical process generation separate.
  const runtimeArtifactMode =
    options?.runtimeArtifactMode ?? (options?.expectedRuntimeArtifact ? "capture" : undefined);
  const expectedRuntimeArtifactKey = options?.expectedRuntimeArtifact
    ? createHash("sha256")
        .update(options.expectedRuntimeArtifact.id)
        .update("\0")
        .update(options.expectedRuntimeArtifact.fingerprint)
        .digest("hex")
    : "mint";
  const key = runtimeArtifactMode
    ? `${baseKey}\0runtime-artifact:capture-v1:${expectedRuntimeArtifactKey}`
    : baseKey;
  const state = getSharedCodexAppServerClientState();
  const entry = getOrCreateSharedClientEntry(state, key);
  if (runtimeArtifactMode) {
    entry.runtimeArtifactStartupAbort ??= new AbortController();
  }
  entry.closeWhenIdle = false;
  const releasePendingAcquire = retainPendingSharedClientAcquire(entry);
  const startedCallback = options?.onStartedClient;
  if (startedCallback) {
    entry.onStartedClientCallbacks.add(startedCallback);
    if (entry.client) {
      startedCallback(entry.client);
    }
  }
  const stopStartedClientNotifications = () => {
    if (startedCallback) {
      entry.onStartedClientCallbacks.delete(startedCallback);
    }
  };
  let cleanupAbandonSignal: (() => void) | undefined;
  if (options?.abandonSignal) {
    const abandon = () => {
      // Release this acquire before cleanup checks ownership; only other
      // pending callers should keep the startup client alive.
      stopStartedClientNotifications();
      releasePendingAcquire();
      retirePendingSharedClientEntryIfUnclaimed(key, entry);
    };
    options.abandonSignal.addEventListener("abort", abandon, { once: true });
    cleanupAbandonSignal = () => options.abandonSignal?.removeEventListener("abort", abandon);
    if (options.abandonSignal.aborted) {
      abandon();
    }
  }
  const startup =
    entry.startup ??
    (entry.startup = createSharedCodexAppServerClientStartup({
      entry,
      key,
      requestedStartOptions,
      startOptions,
      agentDir,
      authProfileId: usesNativeAuth ? null : authProfileId,
      authProfileStore,
      runtimeArtifactMode,
      ...(options?.expectedRuntimeArtifact
        ? { expectedRuntimeArtifact: options.expectedRuntimeArtifact }
        : {}),
      runtimeArtifactSignal: entry.runtimeArtifactStartupAbort?.signal,
      config: options?.config,
    }));
  try {
    await withCodexAppServerAcquireDeadline(
      startup.initialized,
      remainingTimeoutMs,
      options?.abandonSignal,
    );
    const client = await withCodexAppServerAcquireDeadline(
      startup.ready,
      timeoutMs,
      options?.abandonSignal,
      "codex app-server authentication timed out",
    );
    if (entry.closeError) {
      throw entry.closeError;
    }
    // Later leases of the same keyed client may carry fresher config; the
    // runtime install itself stays one-per-physical-client.
    ensureCodexAppServerClientRuntime(client, {
      agentDir,
      authProfileId: usesNativeAuth ? undefined : authProfileId,
      ...(authProfileStore ? { authProfileStore } : {}),
      config: options?.config,
    });
    const release = leaseOptions?.leased ? retainSharedClientEntry(entry) : undefined;
    return release ? { client, release } : { client };
  } catch (error) {
    // This deadline belongs to one waiter, not the shared physical client.
    // Release first so only the final claimant can tear down stalled startup.
    releasePendingAcquire();
    retirePendingSharedClientEntryIfUnclaimed(key, entry);
    throw error;
  } finally {
    cleanupAbandonSignal?.();
    stopStartedClientNotifications();
    releasePendingAcquire();
  }
}

async function withCodexAppServerAcquireDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  timeoutMessage = "codex app-server initialize timed out",
): Promise<T> {
  if (signal?.aborted) {
    throw new Error("codex app-server initialize aborted");
  }
  const timed = withTimeout(promise, timeoutMs, timeoutMessage);
  if (!signal) {
    return await timed;
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("codex app-server initialize aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    timed.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function resolveRemainingAcquireTimeout(timeoutMs: number, startedAt: number): number {
  if (!(timeoutMs > 0)) {
    return timeoutMs;
  }
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) {
    throw new Error("codex app-server initialize timed out");
  }
  return remaining;
}

function createSharedCodexAppServerClientStartup(params: {
  entry: SharedCodexAppServerClientEntry;
  key: string;
  requestedStartOptions: CodexAppServerStartOptions;
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  authProfileId: string | null | undefined;
  authProfileStore?: AuthProfileStore;
  runtimeArtifactMode?: "capture";
  expectedRuntimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  runtimeArtifactSignal?: AbortSignal;
  config?: CodexAppServerClientOptions["config"];
}): SharedCodexAppServerClientStartup {
  const initialized = createDeferred<void>();
  const ready = startInitializedCodexAppServerClient({
    requestedStartOptions: params.requestedStartOptions,
    startOptions: params.startOptions,
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
    runtimeArtifactMode: params.runtimeArtifactMode,
    ...(params.expectedRuntimeArtifact
      ? { expectedRuntimeArtifact: params.expectedRuntimeArtifact }
      : {}),
    runtimeArtifactSignal: params.runtimeArtifactSignal,
    config: params.config,
    onStartedClient: (startedClient) => {
      params.entry.client = startedClient;
      for (const callback of params.entry.onStartedClientCallbacks) {
        callback(startedClient);
      }
      retirePendingSharedClientEntryIfUnclaimed(params.key, params.entry);
    },
    onInitializedClient: () => initialized.resolve(),
  }).then(
    (client) => {
      params.entry.client = client;
      client.addCloseHandler((closedClient) =>
        clearSharedClientEntryIfCurrent(params.key, closedClient),
      );
      return client;
    },
    (error: unknown) => {
      initialized.reject(error);
      throw error;
    },
  );
  // Callers observe pre-initialize failures through the phase promise first.
  void ready.catch(() => undefined);
  return { initialized: initialized.promise, ready };
}

/** Starts a non-shared Codex app-server client owned entirely by the caller. */
export async function createIsolatedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  if (options?.abandonSignal?.aborted) {
    throw new Error("codex app-server initialize aborted");
  }
  const acquireStartedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 0;
  const {
    agentDir,
    usesNativeAuth,
    authProfileId,
    authProfileStore,
    requestedStartOptions,
    startOptions,
  } = await withCodexAppServerAcquireDeadline(
    resolveCodexAppServerClientStartContext(options),
    timeoutMs,
    options?.abandonSignal,
  );
  return await startInitializedCodexAppServerClient({
    requestedStartOptions,
    startOptions,
    agentDir,
    authProfileId: usesNativeAuth ? null : authProfileId,
    authProfileStore,
    runtimeArtifactMode:
      options?.runtimeArtifactMode ?? (options?.expectedRuntimeArtifact ? "capture" : undefined),
    ...(options?.expectedRuntimeArtifact
      ? { expectedRuntimeArtifact: options.expectedRuntimeArtifact }
      : {}),
    runtimeArtifactSignal: options?.abandonSignal,
    config: options?.config,
    timeoutMs: resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt),
    abandonSignal: options?.abandonSignal,
    onStartedClient: options?.onStartedClient,
  });
}

async function startInitializedCodexAppServerClient(params: {
  requestedStartOptions: CodexAppServerStartOptions;
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  authProfileId: string | null | undefined;
  authProfileStore?: AuthProfileStore;
  runtimeArtifactMode?: "capture";
  expectedRuntimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  runtimeArtifactSignal?: AbortSignal;
  config?: CodexAppServerClientOptions["config"];
  timeoutMs?: number;
  abandonSignal?: AbortSignal;
  onStartedClient?: (client: CodexAppServerClient) => void;
  onInitializedClient?: () => void;
}): Promise<CodexAppServerClient> {
  const acquireStartedAt = Date.now();
  const timeoutMs = params.timeoutMs ?? 0;
  const startOptionsCandidates = resolveManagedFallbackStartOptions(params.startOptions);
  for (let index = 0; index < startOptionsCandidates.length; index += 1) {
    const startOptions = startOptionsCandidates[index];
    const runtimeArtifactModule = params.runtimeArtifactMode
      ? await import("./runtime-artifact.js")
      : undefined;
    const nativeCommandBeforeStart =
      startOptions.commandSource === "resolved-managed"
        ? resolveManagedCodexNativeCommand(startOptions.command)
        : undefined;
    const runtimeArtifactBeforeStart = runtimeArtifactModule
      ? await runtimeArtifactModule.captureCodexAppServerRuntimeArtifactBeforeStart({
          startOptions,
          spawnIdentity: resolveCodexAppServerSpawnIdentity(startOptions, nativeCommandBeforeStart),
          signal: params.runtimeArtifactSignal,
        })
      : undefined;
    if (
      runtimeArtifactModule &&
      runtimeArtifactBeforeStart &&
      params.expectedRuntimeArtifact &&
      !runtimeArtifactModule.validateCodexAppServerRuntimeArtifactCapture(
        params.expectedRuntimeArtifact,
        runtimeArtifactBeforeStart,
      )
    ) {
      if (index + 1 < startOptionsCandidates.length) {
        continue;
      }
      throw new Error("Codex app-server runtime artifact does not match verified inference");
    }
    const client = CodexAppServerClient.start(startOptions);
    params.onStartedClient?.(client);
    const initialize = client.initialize();
    try {
      await withCodexAppServerAcquireDeadline(
        initialize,
        resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt),
        params.abandonSignal,
      );
    } catch (error) {
      client.close();
      void initialize.catch(() => undefined);
      if (shouldTryManagedFallbackStartOption(error, startOptions, index, startOptionsCandidates)) {
        continue;
      }
      throw error;
    }

    params.onInitializedClient?.();

    let runtimeArtifact: AgentHarnessRuntimeArtifactBinding | undefined;
    try {
      if (runtimeArtifactModule && runtimeArtifactBeforeStart) {
        const nativeCommand =
          startOptions.commandSource === "resolved-managed"
            ? resolveManagedCodexNativeCommand(startOptions.command)
            : undefined;
        runtimeArtifact = await runtimeArtifactModule.finalizeCodexAppServerRuntimeArtifact({
          before: runtimeArtifactBeforeStart,
          startOptions,
          spawnIdentity: resolveCodexAppServerSpawnIdentity(startOptions, nativeCommand),
          runtimeIdentity: client.getRuntimeIdentity(),
          signal: params.runtimeArtifactSignal,
        });
        if (
          params.expectedRuntimeArtifact &&
          (runtimeArtifact.id !== params.expectedRuntimeArtifact.id ||
            runtimeArtifact.fingerprint !== params.expectedRuntimeArtifact.fingerprint)
        ) {
          throw new Error("Codex app-server runtime artifact does not match verified inference");
        }
      }
    } catch (error) {
      client.close();
      throw error;
    }
    ensureCodexAppServerClientRuntime(client, {
      agentDir: params.agentDir,
      authProfileId: params.authProfileId ?? undefined,
      ...(params.authProfileStore ? { authProfileStore: params.authProfileStore } : {}),
      config: params.config,
    });

    try {
      await withCodexAppServerAcquireDeadline(
        applyCodexAppServerAuthProfile({
          client,
          agentDir: params.agentDir,
          authProfileId: params.authProfileId,
          startOptions,
          config: params.config,
          ...(params.authProfileStore ? { authProfileStore: params.authProfileStore } : {}),
        }),
        resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt),
        params.abandonSignal,
      );
      const nativeCommand =
        startOptions.commandSource === "resolved-managed"
          ? resolveManagedCodexNativeCommand(startOptions.command)
          : undefined;
      if (runtimeArtifactModule && runtimeArtifact) {
        runtimeArtifactModule.bindCodexAppServerRuntimeArtifact(client, runtimeArtifact);
      }
      getCodexAppServerClientStartMetadata().set(client, {
        requestedStartOptions: params.requestedStartOptions,
        startOptions,
        agentDir: params.agentDir,
        ...(nativeCommand ? { nativeCommand } : {}),
      });
      const fenceKey = resolveCodexNativeConfigFenceKey({ client });
      if (fenceKey) {
        client.setThreadSessionRequestGuard(async (options) => {
          const release = await acquireCodexNativeConfigFence(fenceKey, options);
          try {
            assertCodexAppServerClientStartSelectionCurrent({ client });
            return release;
          } catch (error) {
            release();
            throw error;
          }
        });
      }
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  throw new Error("Managed Codex app-server fallback candidates were exhausted.");
}

function resolveManagedFallbackStartOptions(
  startOptions: CodexAppServerStartOptions,
): CodexAppServerStartOptions[] {
  const commands = [startOptions.command, ...(startOptions.managedFallbackCommandPaths ?? [])];
  const candidates: CodexAppServerStartOptions[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const managedFallbackCommandPaths = commands.slice(index + 1);
    const candidate = {
      ...startOptions,
      command,
    };
    if (managedFallbackCommandPaths.length === 0) {
      delete candidate.managedFallbackCommandPaths;
    } else {
      candidate.managedFallbackCommandPaths = managedFallbackCommandPaths;
    }
    candidates.push(candidate);
  }
  return candidates;
}

function shouldTryManagedFallbackStartOption(
  error: unknown,
  startOptions: CodexAppServerStartOptions,
  index: number,
  startOptionsCandidates: readonly CodexAppServerStartOptions[],
): boolean {
  return (
    startOptions.commandSource === "resolved-managed" &&
    index < startOptionsCandidates.length - 1 &&
    isUnsupportedCodexAppServerVersionError(error)
  );
}

/** Clears and closes all shared clients for deterministic tests. */
export function resetSharedCodexAppServerClientForTests(): void {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  state.leasedReleases = new WeakMap();
  for (const client of clients) {
    client.close();
  }
}

/** Clears and closes all shared clients. */
export function clearSharedCodexAppServerClient(): void {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  for (const client of clients) {
    client.close();
  }
}

/** Clears and closes the shared entry only if it still owns the supplied client. */
export function clearSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): boolean {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      client.close();
      return true;
    }
  }
  return false;
}

/** Detaches the shared entry without closing the client when it still matches. */
export function detachSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): boolean {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      return true;
    }
  }
  return false;
}

/** Retains the matching shared client and returns a release callback. */
export function retainSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): (() => void) | undefined {
  if (!client) {
    return undefined;
  }
  const state = getSharedCodexAppServerClientState();
  for (const entry of state.clients.values()) {
    if (entry.client === client) {
      return retainSharedClientEntry(entry);
    }
  }
  return undefined;
}

/**
 * Retires a matching shared client. Default is graceful: detach from the map
 * (future acquisitions get a fresh client) and close once leases drain.
 * `failActiveLeases` is for suspect clients only (timed-out turns): it closes
 * the physical connection immediately so co-leased attempts hit the normal
 * client-closed retry path, and pending acquires reject instead of leasing
 * the poisoned process. Routine cleanup must NOT use it — it would abort
 * healthy sibling turns on a working client.
 */
export function retireSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
  opts?: { failActiveLeases?: boolean },
): { activeLeases: number; closed: boolean } | undefined {
  if (!client) {
    return undefined;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      entry.closeWhenIdle = true;
      if (opts?.failActiveLeases) {
        entry.closeError = new Error("codex app-server client is closed");
        const closed = closeRetiredSharedClientEntry(entry);
        if (closed) {
          suspectClosedClients.add(client);
        }
        return { activeLeases: entry.activeLeases, closed };
      }
      const closed = closeRetiredSharedClientEntryIfIdle(entry);
      return { activeLeases: entry.activeLeases, closed };
    }
  }
  const activeLeases = state.leasedReleases.get(client)?.length ?? 0;
  if (activeLeases > 0) {
    // A gracefully detached client (e.g. one-shot cleanup) can still be leased
    // when a later terminal-idle kill declares it suspect; the map miss must
    // not let the poisoned process keep serving those co-leases.
    if (opts?.failActiveLeases && !suspectClosedClients.has(client)) {
      suspectClosedClients.add(client);
      client.close();
      return { activeLeases, closed: true };
    }
    return { activeLeases, closed: false };
  }
  return undefined;
}

/** Clears a matching shared client and waits for its process to exit. */
export async function clearSharedCodexAppServerClientIfCurrentAndWait(
  client: CodexAppServerClient | undefined,
  options?: {
    exitTimeoutMs?: number;
    forceKillDelayMs?: number;
  },
): Promise<boolean> {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      await client.closeAndWait(options);
      return true;
    }
  }
  return false;
}

/** Clears all shared clients and waits for their processes to exit. */
export async function clearSharedCodexAppServerClientAndWait(options?: {
  exitTimeoutMs?: number;
  forceKillDelayMs?: number;
}): Promise<void> {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  await Promise.all(clients.map((client) => client.closeAndWait(options)));
}

function getOrCreateSharedClientEntry(
  state: SharedCodexAppServerClientState,
  key: string,
): SharedCodexAppServerClientEntry {
  let entry = state.clients.get(key);
  if (!entry) {
    entry = {
      activeLeases: 0,
      pendingAcquires: 0,
      closeWhenIdle: false,
      onStartedClientCallbacks: new Set(),
    };
    state.clients.set(key, entry);
  }
  return entry;
}

function clearSharedClientEntryIfCurrent(key: string, client: CodexAppServerClient): void {
  const state = getSharedCodexAppServerClientState();
  const entry = state.clients.get(key);
  if (entry?.client === client) {
    state.clients.delete(key);
  }
}

/** Clears a matching shared client only when no lease or acquire currently claims it. */
export function clearSharedCodexAppServerClientIfCurrentAndUnclaimed(
  client: CodexAppServerClient | undefined,
): { found: boolean; closed: boolean; activeLeases: number; pendingAcquires: number } {
  if (!client) {
    return { found: false, closed: false, activeLeases: 0, pendingAcquires: 0 };
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      return {
        found: true,
        closed: closeSharedClientEntryIfUnclaimed(key, entry),
        activeLeases: entry.activeLeases,
        pendingAcquires: entry.pendingAcquires,
      };
    }
  }
  return { found: false, closed: false, activeLeases: 0, pendingAcquires: 0 };
}

function retainPendingSharedClientAcquire(entry: SharedCodexAppServerClientEntry): () => void {
  let released = false;
  entry.pendingAcquires += 1;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.pendingAcquires = Math.max(0, entry.pendingAcquires - 1);
    closeRetiredSharedClientEntryIfIdle(entry);
  };
}

function retainSharedClientEntry(entry: SharedCodexAppServerClientEntry): () => void {
  let released = false;
  entry.activeLeases += 1;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.activeLeases = Math.max(0, entry.activeLeases - 1);
    closeRetiredSharedClientEntryIfIdle(entry);
  };
}

function closeRetiredSharedClientEntryIfIdle(entry: SharedCodexAppServerClientEntry): boolean {
  if (
    !entry.closeWhenIdle ||
    entry.activeLeases > 0 ||
    entry.pendingAcquires > 0 ||
    !entry.client
  ) {
    return false;
  }
  const client = entry.client;
  entry.closeWhenIdle = false;
  entry.client = undefined;
  client.close();
  return true;
}

function closeRetiredSharedClientEntry(entry: SharedCodexAppServerClientEntry): boolean {
  const client = entry.client;
  if (!client) {
    return false;
  }
  entry.client = undefined;
  client.close();
  return true;
}

function closeSharedClientEntryIfUnclaimed(
  key: string,
  entry: SharedCodexAppServerClientEntry,
): boolean {
  if (entry.activeLeases > 0 || entry.pendingAcquires > 0) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  if (state.clients.get(key) !== entry) {
    return false;
  }
  state.clients.delete(key);
  entry.client?.close();
  return Boolean(entry.client);
}

function retirePendingSharedClientEntryIfUnclaimed(
  key: string,
  entry: SharedCodexAppServerClientEntry,
): void {
  if (entry.activeLeases > 0 || entry.pendingAcquires > 0) {
    return;
  }
  entry.runtimeArtifactStartupAbort?.abort(
    new Error("Codex runtime artifact startup was abandoned"),
  );
  entry.closeWhenIdle = true;
  const state = getSharedCodexAppServerClientState();
  if (state.clients.get(key) === entry) {
    state.clients.delete(key);
  }
  if (!entry.client) {
    return;
  }
  closeRetiredSharedClientEntry(entry);
}

function collectSharedClients(state: SharedCodexAppServerClientState): CodexAppServerClient[] {
  return [
    ...new Set(
      [...state.clients.values()]
        .map((entry) => entry.client)
        .filter((client): client is CodexAppServerClient => Boolean(client)),
    ),
  ];
}
