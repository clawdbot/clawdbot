/**
 * Owns shared and isolated Codex app-server client startup, auth application,
 * lease tracking, and teardown.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  AgentHarnessPreflightError,
  type AgentHarnessRuntimeArtifactBinding,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveDefaultAgentDir, type AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { CodexAppServerStartupError } from "./attempt-timeouts.js";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore,
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerPreparedAuthProfileSnapshot,
  resolveCodexAppServerPreparedApiKeyCacheKey,
  reconcileCodexComputerUseStartArtifacts,
  type CodexAppServerPreparedAuth,
  type CodexAppServerAuthRequirement,
  type CodexAppServerResolvedPreparedAuth,
} from "./auth-bridge.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { CodexAppServerClient, isUnsupportedCodexAppServerVersionError } from "./client.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexComputerUseConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
  resolveCodexAppServerUserHomeDir,
  type CodexAppServerStartOptions,
} from "./config.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";
import {
  isCodexDesktopGenerationCurrent,
  waitForCodexDesktopGeneration,
} from "./desktop-generation.js";
import {
  isManagedCodexDesktopCommand,
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
} from "./managed-binary.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import { CodexAdoptedThreadActiveError } from "./thread-lifecycle-errors.js";
import { withTimeout } from "./timeout.js";

export type { CodexAppServerPreparedAuth } from "./auth-bridge.js";

const CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE = "codex app-server initialize timed out";

type SharedCodexAppServerClientEntry = {
  client?: CodexAppServerClient;
  startup?: SharedCodexAppServerClientStartup;
  activeLeases: number;
  pendingAcquires: number;
  leaseGeneration: number;
  closeWhenIdle: boolean;
  closeError?: Error;
  startupAbort?: AbortController;
  onStartedClientCallbacks: Set<(client: CodexAppServerClient) => void>;
};

type SharedCodexAppServerClientStartup = {
  initialized: Promise<void>;
  ready: Promise<CodexAppServerClient>;
};

type SharedCodexAppServerClientState = {
  clients: Map<string, SharedCodexAppServerClientEntry>;
  liveClients: Set<CodexAppServerClient>;
  isolatedClients: Set<CodexAppServerClient>;
  entriesByClient: WeakMap<CodexAppServerClient, SharedCodexAppServerClientEntry>;
  leasedReleases: WeakMap<CodexAppServerClient, Array<() => void>>;
  desktopGenerationDrainChecks: Set<() => void>;
};

type CodexAppServerClientStartMetadata = {
  requestedStartOptions: CodexAppServerStartOptions;
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  nativeCommand?: string;
  desktopGeneration?: CodexDesktopGeneration;
};

/** Successful physical process identity, excluding environment and credentials. */
type CodexAppServerClientProcessIdentity = {
  clientId: string;
  command: string;
  argsFingerprint: string;
  commandSource?: CodexAppServerStartOptions["commandSource"];
  managedCommandOrder?: CodexAppServerStartOptions["managedCommandOrder"];
  nativeCommand?: string;
  serverVersion?: string;
  userAgent?: string;
};

type CodexAppServerSpawnIdentity = Omit<
  CodexAppServerClientProcessIdentity,
  "clientId" | "serverVersion" | "userAgent"
>;

// Symbol.for shares one client table across duplicate module copies (dist +
// src bundles in one process). Plugin updates restart the gateway, so every
// copy writing this state runs the same code and the shape never migrates.
const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");
const SHARED_CODEX_APP_SERVER_CLIENT_DISPOSER = Symbol.for("openclaw.codexAppServerClientDisposer");
const CODEX_APP_SERVER_CLIENT_START_METADATA = Symbol.for(
  "openclaw.codexAppServerClientStartMetadata",
);

function getSharedCodexAppServerClientState(): SharedCodexAppServerClientState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_STATE]?: SharedCodexAppServerClientState;
  };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] ??= {
    clients: new Map(),
    liveClients: new Set(),
    isolatedClients: new Set(),
    entriesByClient: new WeakMap(),
    leasedReleases: new WeakMap(),
    desktopGenerationDrainChecks: new Set(),
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

/** Returns the lifecycle fingerprint that owns a managed desktop client. */
export function readCodexAppServerClientDesktopGenerationFingerprint(
  client: CodexAppServerClient,
): string | undefined {
  return readCodexAppServerClientDesktopGeneration(client)?.fingerprint;
}

/** Returns the lifecycle generation that owns a managed desktop client. */
export function readCodexAppServerClientDesktopGeneration(
  client: CodexAppServerClient,
): CodexDesktopGeneration | undefined {
  return getCodexAppServerClientStartMetadata().get(client)?.desktopGeneration;
}

/** Waits until older physical desktop clients for this client's Codex home exit. */
export async function waitForCodexAppServerClientDesktopGenerationDrain(params: {
  client: CodexAppServerClient;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  const metadata = getCodexAppServerClientStartMetadata().get(params.client);
  if (!metadata?.desktopGeneration) {
    return;
  }
  const drain = createOlderDesktopGenerationDrainWait({
    generation: metadata.desktopGeneration,
    startOptions: metadata.startOptions,
    agentDir: metadata.agentDir,
  });
  try {
    await withCodexAppServerAcquireDeadline(
      params.timeoutMs ?? 0,
      drain.promise,
      params.signal,
      "Codex Computer Use install timed out waiting for older desktop clients",
    );
  } finally {
    drain.cancel();
  }
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

class CodexAppServerStartSelectionChangedError extends Error {
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
  if (metadata.desktopGeneration && !isCodexDesktopGenerationCurrent(metadata.desktopGeneration)) {
    throw new CodexAppServerStartSelectionChangedError();
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
  const startOptions = metadata?.startOptions ?? params.startOptions;
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
  preparedAuth?: CodexAppServerPreparedAuth;
  authRequirement?: CodexAppServerAuthRequirement;
  agentId?: string;
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
  preparedAuth: CodexAppServerResolvedPreparedAuth | undefined;
  authRequirement: CodexAppServerAuthRequirement | undefined;
  requestedStartOptions: CodexAppServerStartOptions;
  startOptions: CodexAppServerStartOptions;
  desktopGeneration?: CodexDesktopGeneration;
  pluginConfig?: unknown;
};

function inferAuthRequirement(
  preparedAuth: CodexAppServerPreparedAuth | undefined,
): CodexAppServerAuthRequirement | undefined {
  if (preparedAuth?.kind === "api-key") {
    return "api-key";
  }
  return preparedAuth?.kind === "profile" ? "subscription" : undefined;
}

async function resolveCodexAppServerClientStartContext(
  options?: CodexAppServerClientOptions,
): Promise<ResolvedCodexAppServerClientStartContext> {
  const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const desktopGeneration = shouldTrackDesktopGeneration(
    requestedStartOptions,
    options?.pluginConfig,
  )
    ? await waitForCodexDesktopGeneration()
    : undefined;
  const preparedAuth = options?.preparedAuth;
  const preparedApiKey = preparedAuth?.kind === "api-key" ? preparedAuth.apiKey.trim() : undefined;
  if (preparedAuth && options?.authProfileId !== undefined) {
    throw new Error("Prepared Codex auth cannot also select a legacy auth profile.");
  }
  if (preparedAuth?.kind === "profile" && !preparedAuth.store.profiles[preparedAuth.profileId]) {
    throw new Error(
      `Prepared Codex auth profile "${preparedAuth.profileId}" was not found. Select an existing OpenAI profile or sign in again with OpenClaw, then retry.`,
    );
  }
  if (preparedAuth?.kind === "api-key" && !preparedApiKey) {
    throw new Error("Prepared Codex API-key auth is missing its resolved key.");
  }
  if (preparedAuth && requestedStartOptions.homeScope === "user") {
    // Backstop for the auth-bridge handoff: an app-server on the operator's native
    // home persists api-key logins into CODEX_HOME/auth.json and replaces the live
    // ChatGPT account for token logins, so prepared auth must never reach it.
    throw new Error("Prepared Codex auth requires an isolated app-server home.");
  }
  const preparedAuthRequirement = inferAuthRequirement(preparedAuth);
  if (
    options?.authRequirement &&
    preparedAuthRequirement &&
    options.authRequirement !== preparedAuthRequirement
  ) {
    throw new Error("Prepared Codex auth does not satisfy the requested auth requirement.");
  }
  const authRequirement = options?.authRequirement ?? preparedAuthRequirement;
  const usesNativeAuth =
    !preparedAuth &&
    (options?.authProfileId === null || requestedStartOptions.homeScope === "user");
  const requestedAuthProfileId =
    preparedAuth?.kind === "profile"
      ? preparedAuth.profileId
      : (options?.authProfileId ?? undefined);
  const authProfileStore =
    preparedAuth?.kind === "profile"
      ? preparedAuth.store
      : !usesNativeAuth && preparedAuth?.kind !== "api-key"
        ? resolveCodexAppServerAuthProfileStore({
            agentDir,
            authProfileId: requestedAuthProfileId,
            authProfileStore: options?.authProfileStore,
            config: options?.config,
          })
        : options?.authProfileStore;
  const authProfileId =
    preparedAuth?.kind === "profile"
      ? preparedAuth.profileId
      : usesNativeAuth || preparedAuth?.kind === "api-key"
        ? undefined
        : resolveCodexAppServerAuthProfileIdForAgent({
            authProfileId: requestedAuthProfileId,
            agentDir,
            config: options?.config,
            ...(authProfileStore ? { authProfileStore } : {}),
          });
  // Resolve the selected profile once: the keyed process must log in with the
  // same account material, including ordinary catalog callers without prepared auth.
  const preparedAuthProfileSnapshot =
    !usesNativeAuth && authProfileId
      ? ((preparedAuth?.kind === "profile" ? preparedAuth.snapshot : undefined) ??
        (await resolveCodexAppServerPreparedAuthProfileSnapshot({
          authProfileId,
          authProfileStore,
          agentDir,
          config: options?.config,
        })))
      : undefined;
  if (preparedAuth?.kind === "profile" && !preparedAuthProfileSnapshot) {
    throw new Error(
      `Prepared Codex auth profile "${preparedAuth.profileId}" is unusable. Repair or replace the selected OpenAI profile, then retry.`,
    );
  }
  const resolvedPreparedAuth: CodexAppServerResolvedPreparedAuth | undefined =
    preparedAuth?.kind === "api-key"
      ? { kind: "api-key", apiKey: preparedApiKey as string }
      : preparedAuthProfileSnapshot && authProfileId && authProfileStore
        ? {
            kind: "profile",
            profileId: authProfileId,
            store: authProfileStore,
            snapshot: preparedAuthProfileSnapshot,
          }
        : undefined;
  const agentStartOptions = resolveCodexAppServerStartOptionsForAgent({
    startOptions: requestedStartOptions,
    agentDir,
  });
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(agentStartOptions);
  // Preserve ordinary profile environment policy; only explicitly prepared
  // handoffs clear all inherited auth variables before spawning.
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentId: options?.agentId,
    agentDir,
    authProfileId: usesNativeAuth || preparedAuth?.kind === "api-key" ? null : authProfileId,
    ...(preparedAuth && resolvedPreparedAuth ? { preparedAuth: resolvedPreparedAuth } : {}),
    authRequirement,
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
    preparedAuth: resolvedPreparedAuth,
    authRequirement,
    startOptions,
    ...(options?.pluginConfig !== undefined ? { pluginConfig: options.pluginConfig } : {}),
    ...(desktopGeneration ? { desktopGeneration } : {}),
  };
}

function shouldTrackDesktopGeneration(
  startOptions: CodexAppServerStartOptions,
  pluginConfig: unknown,
): boolean {
  if (startOptions.transport !== "stdio") {
    return false;
  }
  // A managed package process can publish desktop-owned Computer Use artifacts,
  // so both share one generation. Custom operator commands remain independent.
  if (
    resolveCodexComputerUseConfig({ pluginConfig }).enabled &&
    (startOptions.commandSource === "managed" || startOptions.commandSource === "resolved-managed")
  ) {
    return true;
  }
  return (
    startOptions.commandSource === "managed" &&
    (startOptions.managedCommandOrder ?? "package-first") === "desktop-first"
  );
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

export type CodexAppServerLeasedRequestOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  assertCurrent: () => void;
};

/** Retries one config-loading operation with a shared deadline and current client lease. */
export async function withLeasedCodexAppServerClientStartSelectionRetry<T>(params: {
  lease: CodexAppServerClientLease;
  options?: CodexAppServerClientOptions;
  signal?: AbortSignal;
  run: (
    client: CodexAppServerClient,
    requestOptions: () => CodexAppServerLeasedRequestOptions,
  ) => Promise<T>;
  onClientChange?: (client: CodexAppServerClient) => void;
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
      throw new CodexAppServerStartupError("aborted", "Codex app-server selection retry aborted");
    }
    const remainingTimeoutMs = deadline - Date.now();
    if (remainingTimeoutMs <= 0) {
      throw new CodexAppServerStartupError(
        "timed_out",
        "Codex app-server selection retry timed out",
      );
    }
    return {
      timeoutMs: remainingTimeoutMs,
      ...(signal ? { signal } : {}),
    };
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptClient = client;
    let scopeActive = true;
    const assertCurrent = () => {
      if (!scopeActive || params.lease.client !== attemptClient) {
        throw new CodexAppServerStartupError("aborted", "Codex app-server request scope is closed");
      }
    };
    try {
      requestOptions();
      return await params.run(client, () => {
        assertCurrent();
        // Sample the deadline before each request or commit. Cleanup keeps the
        // lease-only assertion so an accepted native operation can finish safely.
        return { ...requestOptions(), assertCurrent };
      });
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
      params.onClientChange?.(client);
    } finally {
      scopeActive = false;
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
    throw new CodexAppServerStartupError("aborted", "codex app-server initialize aborted");
  }
  const acquireStartedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 0;
  const state = getSharedCodexAppServerClientState();
  const context = await withCodexAppServerAcquireDeadline(
    timeoutMs,
    resolveCodexAppServerClientStartContext(options),
    options?.abandonSignal,
  );
  const {
    agentDir,
    usesNativeAuth,
    authProfileId,
    authProfileStore,
    preparedAuth,
    authRequirement,
    requestedStartOptions,
    startOptions,
    desktopGeneration,
    pluginConfig,
  } = context;
  const remainingTimeoutMs = resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt);
  const authIdentityCacheKey =
    preparedAuth?.kind === "api-key"
      ? resolveCodexAppServerPreparedApiKeyCacheKey(preparedAuth.apiKey)
      : (preparedAuth?.snapshot.secretFreeCacheKey ??
        (authRequirement === "api-key" && !authProfileId
          ? resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions })
          : undefined));
  const baseKey = `${codexAppServerStartOptionsKey(startOptions, {
    authProfileId,
    authBindingFingerprint: options?.authBindingFingerprint,
    agentDir: usesNativeAuth ? undefined : agentDir,
    fallbackApiKeyCacheKey: authIdentityCacheKey,
  })}\0auth-requirement:${authRequirement ?? "native"}${
    desktopGeneration ? `\0desktop-generation:${desktopGeneration.epoch}` : ""
  }`;
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
  let entry = getOrCreateSharedClientEntry(state, key);
  const existingClient = entry.client;
  const existingGeneration = existingClient
    ? getCodexAppServerClientStartMetadata().get(existingClient)?.desktopGeneration
    : undefined;
  if (
    existingClient &&
    existingGeneration &&
    !isCodexDesktopGenerationCurrent(existingGeneration)
  ) {
    retireSharedCodexAppServerClientIfCurrent(existingClient);
    entry = getOrCreateSharedClientEntry(state, key);
  }
  entry.startupAbort ??= new AbortController();
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
      desktopGeneration,
      ...(pluginConfig !== undefined ? { pluginConfig } : {}),
      agentDir,
      authProfileId: usesNativeAuth || preparedAuth?.kind === "api-key" ? null : authProfileId,
      authProfileStore,
      preparedAuth,
      authRequirement,
      runtimeArtifactMode,
      ...(options?.expectedRuntimeArtifact
        ? { expectedRuntimeArtifact: options.expectedRuntimeArtifact }
        : {}),
      runtimeArtifactSignal: entry.startupAbort.signal,
      abandonSignal: entry.startupAbort.signal,
      config: options?.config,
    }));
  try {
    await withCodexAppServerAcquireDeadline(
      remainingTimeoutMs,
      startup.initialized,
      options?.abandonSignal,
      CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE,
      () => buildCodexAppServerInitializeTimeoutError(entry.client),
    );
    const client = await withCodexAppServerAcquireDeadline(
      timeoutMs,
      startup.ready,
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
      authMode: preparedAuth?.kind === "api-key" ? "prepared-api-key" : "profile",
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
  timeoutMs: number, // First: fail before the caller starts its promise argument.
  promise: Promise<T>,
  signal?: AbortSignal,
  timeoutMessage = CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE,
  timeoutErrorFactory?: () => CodexAppServerStartupError,
): Promise<T> {
  if (signal?.aborted) {
    throw new CodexAppServerStartupError("aborted", "codex app-server initialize aborted");
  }
  const timed = withTimeout(
    promise,
    timeoutMs,
    timeoutMessage,
    () => timeoutErrorFactory?.() ?? new CodexAppServerStartupError("timed_out", timeoutMessage),
  );
  if (!signal) {
    return await timed;
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new CodexAppServerStartupError("aborted", "codex app-server initialize aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    timed.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function buildCodexAppServerInitializeTimeoutError(
  client: CodexAppServerClient | undefined,
): CodexAppServerStartupError {
  const stderr = client?.getStderrDiagnostic();
  return new CodexAppServerStartupError(
    "timed_out",
    stderr
      ? `${CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE}; stderr=${JSON.stringify(stderr)}`
      : CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE,
  );
}

function resolveRemainingAcquireTimeout(timeoutMs: number, startedAt: number): number {
  if (!(timeoutMs > 0)) {
    return timeoutMs;
  }
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) {
    throw new CodexAppServerStartupError("timed_out", "codex app-server initialize timed out");
  }
  return remaining;
}

function createSharedCodexAppServerClientStartup(params: {
  entry: SharedCodexAppServerClientEntry;
  key: string;
  requestedStartOptions: CodexAppServerStartOptions;
  startOptions: CodexAppServerStartOptions;
  desktopGeneration?: CodexDesktopGeneration;
  pluginConfig?: unknown;
  agentDir: string;
  authProfileId: string | null | undefined;
  authProfileStore?: AuthProfileStore;
  runtimeArtifactMode?: "capture";
  expectedRuntimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  runtimeArtifactSignal?: AbortSignal;
  abandonSignal?: AbortSignal;
  preparedAuth?: CodexAppServerResolvedPreparedAuth;
  authRequirement?: CodexAppServerAuthRequirement;
  config?: CodexAppServerClientOptions["config"];
}): SharedCodexAppServerClientStartup {
  const initialized = createDeferred<void>();
  const ready = startInitializedCodexAppServerClient({
    requestedStartOptions: params.requestedStartOptions,
    startOptions: params.startOptions,
    ...(params.desktopGeneration ? { desktopGeneration: params.desktopGeneration } : {}),
    ...(params.pluginConfig !== undefined ? { pluginConfig: params.pluginConfig } : {}),
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
    preparedAuth: params.preparedAuth,
    authRequirement: params.authRequirement,
    runtimeArtifactMode: params.runtimeArtifactMode,
    ...(params.expectedRuntimeArtifact
      ? { expectedRuntimeArtifact: params.expectedRuntimeArtifact }
      : {}),
    runtimeArtifactSignal: params.runtimeArtifactSignal,
    abandonSignal: params.abandonSignal,
    config: params.config,
    onStartedClient: (startedClient) => {
      const state = getSharedCodexAppServerClientState();
      params.entry.client = startedClient;
      // Graceful retirement detaches active clients from the acquisition map,
      // so generation fencing tracks physical lifetime until transport exit.
      state.liveClients.add(startedClient);
      startedClient.addTransportExitHandler((exitedClient) => {
        state.liveClients.delete(exitedClient);
        notifyDesktopGenerationDrainChecks(state);
      });
      startedClient.addCloseHandler((closedClient) => {
        if (state.entriesByClient.get(closedClient) === params.entry) {
          clearSharedClientEntryIfCurrent(params.key, closedClient);
        }
      });
      for (const callback of params.entry.onStartedClientCallbacks) {
        callback(startedClient);
      }
      retirePendingSharedClientEntryIfUnclaimed(params.key, params.entry);
    },
    onInitializedClient: () => initialized.resolve(),
  }).then(
    (client) => {
      const state = getSharedCodexAppServerClientState();
      params.entry.client = client;
      state.entriesByClient.set(client, params.entry);
      return client;
    },
    (error: unknown) => {
      initialized.reject(error);
      throw error;
    },
  );
  // Callers observe pre-initialize failures through the phase promise first.
  void initialized.promise.catch(() => undefined);
  void ready.catch(() => undefined);
  return { initialized: initialized.promise, ready };
}

/** Starts a non-shared Codex app-server client owned entirely by the caller. */
export async function createIsolatedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  if (options?.abandonSignal?.aborted) {
    throw new CodexAppServerStartupError("aborted", "codex app-server initialize aborted");
  }
  const acquireStartedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 0;
  const {
    agentDir,
    usesNativeAuth,
    authProfileId,
    authProfileStore,
    preparedAuth,
    authRequirement,
    requestedStartOptions,
    startOptions,
    desktopGeneration,
    pluginConfig,
  } = await withCodexAppServerAcquireDeadline(
    timeoutMs,
    resolveCodexAppServerClientStartContext(options),
    options?.abandonSignal,
  );
  return await startInitializedCodexAppServerClient({
    requestedStartOptions,
    startOptions,
    ...(desktopGeneration ? { desktopGeneration } : {}),
    ...(pluginConfig !== undefined ? { pluginConfig } : {}),
    agentDir,
    authProfileId: usesNativeAuth || preparedAuth?.kind === "api-key" ? null : authProfileId,
    authProfileStore,
    preparedAuth,
    authRequirement,
    runtimeArtifactMode:
      options?.runtimeArtifactMode ?? (options?.expectedRuntimeArtifact ? "capture" : undefined),
    ...(options?.expectedRuntimeArtifact
      ? { expectedRuntimeArtifact: options.expectedRuntimeArtifact }
      : {}),
    runtimeArtifactSignal: options?.abandonSignal,
    config: options?.config,
    timeoutMs: resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt),
    abandonSignal: options?.abandonSignal,
    onStartedClient: (client) => {
      trackIsolatedCodexAppServerClient(client);
      options?.onStartedClient?.(client);
    },
  });
}

function trackIsolatedCodexAppServerClient(client: CodexAppServerClient): void {
  const state = getSharedCodexAppServerClientState();
  state.isolatedClients.add(client);
  client.addTransportExitHandler((exitedClient) => {
    state.isolatedClients.delete(exitedClient);
    notifyDesktopGenerationDrainChecks(state);
  });
}

async function startInitializedCodexAppServerClient(params: {
  requestedStartOptions: CodexAppServerStartOptions;
  startOptions: CodexAppServerStartOptions;
  desktopGeneration?: CodexDesktopGeneration;
  pluginConfig?: unknown;
  agentDir: string;
  authProfileId: string | null | undefined;
  authProfileStore?: AuthProfileStore;
  runtimeArtifactMode?: "capture";
  expectedRuntimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  runtimeArtifactSignal?: AbortSignal;
  preparedAuth?: CodexAppServerResolvedPreparedAuth;
  authRequirement?: CodexAppServerAuthRequirement;
  config?: CodexAppServerClientOptions["config"];
  timeoutMs?: number;
  abandonSignal?: AbortSignal;
  onStartedClient?: (client: CodexAppServerClient) => void;
  onInitializedClient?: () => void;
}): Promise<CodexAppServerClient> {
  const acquireStartedAt = Date.now();
  const timeoutMs = params.timeoutMs ?? 0;
  const startOptionsCandidates = resolveManagedFallbackStartOptions(params.startOptions);
  for (const [index, startOptions] of startOptionsCandidates.entries()) {
    const desktopGeneration =
      params.desktopGeneration ??
      (isManagedCodexDesktopCommand(startOptions.command)
        ? await withCodexAppServerAcquireDeadline(
            resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt),
            waitForCodexDesktopGeneration(),
            params.abandonSignal,
          )
        : undefined);
    const assertDesktopGenerationCurrent = () => {
      if (params.abandonSignal?.aborted) {
        throw new CodexAppServerStartupError("aborted", "codex app-server initialize aborted");
      }
      if (desktopGeneration && !isCodexDesktopGenerationCurrent(desktopGeneration)) {
        throw new CodexAppServerStartSelectionChangedError();
      }
    };
    const computerUseConfig = resolveCodexComputerUseConfig({ pluginConfig: params.pluginConfig });
    const ownsIsolatedCodexHome =
      params.requestedStartOptions.homeScope !== "user" &&
      !params.requestedStartOptions.env?.CODEX_HOME?.trim();
    const needsComputerUseArtifactDrain =
      desktopGeneration &&
      ownsIsolatedCodexHome &&
      computerUseConfig.enabled &&
      (computerUseConfig.autoInstall || computerUseConfig.pluginCacheMode === "shared");
    const artifactDrain = needsComputerUseArtifactDrain
      ? createOlderDesktopGenerationDrainWait({
          generation: desktopGeneration,
          startOptions,
          agentDir: params.agentDir,
        })
      : undefined;
    try {
      if (artifactDrain) {
        // These artifacts have stable paths per CODEX_HOME. Publish Y only after
        // every X claimant has stopped reading X, or an active turn can mix both.
        await withCodexAppServerAcquireDeadline(
          resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt),
          artifactDrain.promise,
          params.abandonSignal,
        );
      }
      await reconcileCodexComputerUseStartArtifacts({
        startOptions,
        agentDir: params.agentDir,
        pluginConfig: params.pluginConfig,
        ...(desktopGeneration ? { desktopGeneration } : {}),
        assertCurrent: assertDesktopGenerationCurrent,
        ownsIsolatedCodexHome,
      });
    } catch (error) {
      if (isCodexComputerUseCandidateArtifactsUnavailableError(error)) {
        if (index + 1 < startOptionsCandidates.length) {
          continue;
        }
        throw new AgentHarnessPreflightError(
          "Codex Computer Use artifacts are unavailable from the installed desktop apps.",
          { cause: error, scope: "harness" },
        );
      }
      throw error;
    } finally {
      artifactDrain?.cancel();
    }
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
    assertDesktopGenerationCurrent();
    let starting: Promise<CodexAppServerClient> | undefined;
    let client: CodexAppServerClient;
    try {
      client = await withCodexAppServerAcquireDeadline(
        resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt),
        (starting = CodexAppServerClient.start(startOptions, () => {
          assertDesktopGenerationCurrent();
          resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt);
        })),
        params.abandonSignal,
      );
    } catch (error) {
      // A timed-out registration may settle later; it cannot publish a live
      // client after the acquisition owner has already released its claim.
      void starting?.then(
        (lateClient) => lateClient.close(),
        () => {},
      );
      throw error;
    }
    const nativeCommandAtStart =
      startOptions.commandSource === "resolved-managed"
        ? resolveManagedCodexNativeCommand(startOptions.command)
        : undefined;
    getCodexAppServerClientStartMetadata().set(client, {
      requestedStartOptions: params.requestedStartOptions,
      startOptions,
      agentDir: params.agentDir,
      ...(nativeCommandAtStart ? { nativeCommand: nativeCommandAtStart } : {}),
      ...(desktopGeneration ? { desktopGeneration } : {}),
    });
    params.onStartedClient?.(client);
    let initialize: Promise<void> | undefined;
    try {
      await withCodexAppServerAcquireDeadline(
        resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt),
        (initialize = client.initialize()),
        params.abandonSignal,
        CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE,
        () => buildCodexAppServerInitializeTimeoutError(client),
      );
    } catch (error) {
      client.close();
      void initialize?.catch(() => undefined);
      if (shouldTryManagedFallbackStartOption(error, startOptions, index, startOptionsCandidates)) {
        continue;
      }
      throw error;
    }

    try {
      assertDesktopGenerationCurrent();
    } catch (error) {
      client.close();
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
      authMode: params.preparedAuth?.kind === "api-key" ? "prepared-api-key" : "profile",
      ...(params.authProfileStore ? { authProfileStore: params.authProfileStore } : {}),
      config: params.config,
      onAuthRefreshFailure: () => retireSharedCodexAppServerClientIfCurrent(client),
    });

    try {
      assertDesktopGenerationCurrent();
      await withCodexAppServerAcquireDeadline(
        resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt),
        applyCodexAppServerAuthProfile({
          client,
          agentDir: params.agentDir,
          authProfileId: params.authProfileId,
          preparedAuth: params.preparedAuth,
          authRequirement: params.authRequirement,
          startOptions,
          config: params.config,
          ...(params.authProfileStore ? { authProfileStore: params.authProfileStore } : {}),
        }),
        params.abandonSignal,
      );
      if (runtimeArtifactModule && runtimeArtifact) {
        runtimeArtifactModule.bindCodexAppServerRuntimeArtifact(client, runtimeArtifact);
      }
      assertDesktopGenerationCurrent();
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

function isCodexComputerUseCandidateArtifactsUnavailableError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE"
  );
}

function resolveManagedFallbackStartOptions(
  startOptions: CodexAppServerStartOptions,
): CodexAppServerStartOptions[] {
  const commands = [startOptions.command, ...(startOptions.managedFallbackCommandPaths ?? [])];
  const candidates: CodexAppServerStartOptions[] = [];
  for (const [index, command] of commands.entries()) {
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
  const isolatedClients = [...state.isolatedClients];
  state.clients.clear();
  state.liveClients.clear();
  state.isolatedClients.clear();
  state.entriesByClient = new WeakMap();
  state.leasedReleases = new WeakMap();
  for (const client of clients) {
    client.close();
  }
  for (const client of isolatedClients) {
    client.close();
  }
  notifyDesktopGenerationDrainChecks(state);
}

/** Clears and closes all shared clients. */
export function clearSharedCodexAppServerClient(): void {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  for (const client of clients) {
    client.close();
  }
  notifyDesktopGenerationDrainChecks(state);
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

/** Captures a revocable observation of the exact shared client and native account/config. */
export function captureSharedCodexAppServerCatalogLifetime(
  client: CodexAppServerClient,
): () => boolean {
  const state = getSharedCodexAppServerClientState();
  const entry = state.entriesByClient.get(client);
  const key = [...state.clients].find(([, candidate]) => candidate === entry)?.[0];
  const generation = readCodexAppServerClientDesktopGeneration(client);
  const revision = client.getModelCatalogRevision();
  // Detachment retires an owner even while outstanding leases keep its process alive.
  return () =>
    key !== undefined &&
    state.clients.get(key) === entry &&
    entry?.client === client &&
    !entry.closeWhenIdle &&
    !entry.closeError &&
    !client.getCloseError() &&
    client.getModelCatalogRevision() === revision &&
    (!generation || isCodexDesktopGenerationCurrent(generation));
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

/** Retains the live shared client whose initialized instance id matches a thread binding. */
export function retainSharedCodexAppServerClientByInstanceId(
  clientId: string | undefined,
): { client: CodexAppServerClient; release: () => void } | undefined {
  const normalizedClientId = clientId?.trim();
  if (!normalizedClientId) {
    return undefined;
  }
  for (const entry of getSharedCodexAppServerClientState().clients.values()) {
    const client = entry.client;
    if (client?.getInstanceId() !== normalizedClientId || entry.closeWhenIdle || entry.closeError) {
      continue;
    }
    return { client, release: retainSharedClientEntry(entry) };
  }
  return undefined;
}

/** Captures sole physical-client ownership across awaited configuration adoption. */
export function captureExclusiveSharedCodexAppServerClient(
  client: CodexAppServerClient,
): () => void {
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client !== client) {
      continue;
    }
    const generation = entry.leaseGeneration;
    const assertExclusive = () => {
      // A sibling can resume native children without OpenClaw's thread queue.
      // Even a completed intervening lease invalidates this configuration proof.
      if (
        state.clients.get(key) !== entry ||
        entry.client !== client ||
        entry.closeWhenIdle ||
        entry.closeError ||
        entry.activeLeases !== 1 ||
        entry.pendingAcquires !== 0 ||
        entry.leaseGeneration !== generation
      ) {
        throw new CodexAdoptedThreadActiveError();
      }
    };
    assertExclusive();
    return assertExclusive;
  }
  throw new CodexAdoptedThreadActiveError();
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
        return {
          activeLeases: entry.activeLeases,
          closed: closeRetiredSharedClientEntry(entry),
        };
      }
      const closed = closeRetiredSharedClientEntryIfIdle(entry);
      return { activeLeases: entry.activeLeases, closed };
    }
  }
  const detachedEntry = state.entriesByClient.get(client);
  if (detachedEntry && (detachedEntry.client === client || detachedEntry.closeError)) {
    // Explicit native-subagent retains are not listed in leasedReleases; the
    // detached entry owns every lease and records an already-forced closure.
    if (opts?.failActiveLeases && !detachedEntry.closeError) {
      detachedEntry.closeError = new Error("codex app-server client is closed");
      return {
        activeLeases: detachedEntry.activeLeases,
        closed: closeRetiredSharedClientEntry(detachedEntry),
      };
    }
    return { activeLeases: detachedEntry.activeLeases, closed: false };
  }
  return undefined;
}

/** Gracefully retires exact clients attached to an older desktop generation. */
export function retireSharedCodexAppServerClientsBeforeDesktopGeneration(
  generation: CodexDesktopGeneration,
): void {
  const state = getSharedCodexAppServerClientState();
  for (const entry of state.clients.values()) {
    const client = entry.client;
    const attached = client ? getCodexAppServerClientStartMetadata().get(client) : undefined;
    if (
      client &&
      attached?.desktopGeneration &&
      attached.desktopGeneration.epoch < generation.epoch
    ) {
      retireSharedCodexAppServerClientIfCurrent(client);
    }
  }
}

function createOlderDesktopGenerationDrainWait(params: {
  generation: CodexDesktopGeneration;
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
}): { promise: Promise<void>; cancel: () => void } {
  const targetHome = resolveCodexNativeConfigFenceKey({
    startOptions: params.startOptions,
    agentDir: params.agentDir,
  });
  if (!targetHome) {
    return { promise: Promise.resolve(), cancel: () => undefined };
  }
  const state = getSharedCodexAppServerClientState();
  let settled = false;
  let resolveWait!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });
  const cancel = () => {
    if (settled) {
      return;
    }
    settled = true;
    state.desktopGenerationDrainChecks.delete(check);
    resolveWait();
  };
  const check = () => {
    if (
      !hasLiveOlderDesktopGenerationClient({
        state,
        generation: params.generation,
        targetHome,
      })
    ) {
      cancel();
    }
  };
  state.desktopGenerationDrainChecks.add(check);
  check();
  return { promise, cancel };
}

function hasLiveOlderDesktopGenerationClient(params: {
  state: SharedCodexAppServerClientState;
  generation: CodexDesktopGeneration;
  targetHome: string;
}): boolean {
  for (const client of params.state.liveClients) {
    if (isOlderDesktopGenerationClientForHome(client, params.generation, params.targetHome)) {
      return true;
    }
  }
  for (const client of params.state.isolatedClients) {
    if (isOlderDesktopGenerationClientForHome(client, params.generation, params.targetHome)) {
      return true;
    }
  }
  return false;
}

function isOlderDesktopGenerationClientForHome(
  client: CodexAppServerClient,
  generation: CodexDesktopGeneration,
  targetHome: string,
): boolean {
  const metadata = getCodexAppServerClientStartMetadata().get(client);
  return Boolean(
    metadata?.desktopGeneration &&
    metadata.desktopGeneration.epoch < generation.epoch &&
    resolveCodexNativeConfigFenceKey({ client }) === targetHome,
  );
}

function notifyDesktopGenerationDrainChecks(state: SharedCodexAppServerClientState): void {
  for (const check of state.desktopGenerationDrainChecks) {
    check();
  }
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

(
  globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_DISPOSER]?: () => Promise<void>;
  }
)[SHARED_CODEX_APP_SERVER_CLIENT_DISPOSER] = clearSharedCodexAppServerClientAndWait;

function getOrCreateSharedClientEntry(
  state: SharedCodexAppServerClientState,
  key: string,
): SharedCodexAppServerClientEntry {
  let entry = state.clients.get(key);
  if (!entry) {
    entry = {
      activeLeases: 0,
      pendingAcquires: 0,
      leaseGeneration: 0,
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
  entry.leaseGeneration += 1;
  entry.pendingAcquires += 1;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.pendingAcquires = Math.max(0, entry.pendingAcquires - 1);
    closeRetiredSharedClientEntryIfIdle(entry);
    notifyDesktopGenerationDrainChecks(getSharedCodexAppServerClientState());
  };
}

function retainSharedClientEntry(entry: SharedCodexAppServerClientEntry): () => void {
  let released = false;
  entry.leaseGeneration += 1;
  entry.activeLeases += 1;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.activeLeases = Math.max(0, entry.activeLeases - 1);
    closeRetiredSharedClientEntryIfIdle(entry);
    notifyDesktopGenerationDrainChecks(getSharedCodexAppServerClientState());
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
  entry.startupAbort?.abort(new Error("Codex app-server startup was abandoned"));
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
  return [...state.liveClients];
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
