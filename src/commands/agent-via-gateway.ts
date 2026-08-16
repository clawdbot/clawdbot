// Gateway-first agent CLI implementation with explicit --local embedded execution.
import fs from "node:fs/promises";
import { TextDecoder } from "node:util";
import {
  parseStrictNonNegativeInteger,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { AgentsListResult } from "../../packages/gateway-protocol/src/index.js";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  tryResolveSoleAgentId,
} from "../agents/agent-scope-config.js";
import { measureAgentStartup } from "../agents/startup-timing.js";
import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { CliDeps } from "../cli/deps.types.js";
import { withProgress } from "../cli/progress.js";
import {
  readGatewayDispatchConfig,
  readGatewayDispatchConfigWithShellEnvFallback,
} from "../config/gateway-dispatch-config.js";
import {
  inheritLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../config/legacy.default-agent-owner.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  callGateway,
  isGatewayCredentialsRequiredError,
  isGatewayExplicitAuthRequiredError,
  isGatewayTransportError,
  randomIdempotencyKey,
  type GatewayRequestFunction,
} from "../gateway/call.js";
import { isGatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import { ADMIN_SCOPE, READ_SCOPE } from "../gateway/operator-scopes.js";
import { createAbortError } from "../infra/abort-signal.js";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import {
  createEmbeddedStateSignalBridge,
  type EmbeddedStateSignal,
  type EmbeddedStateSignalProcess,
} from "../infra/embedded-state-lock.js";
import type { GatewayLockIdentity, GatewayLockOptions } from "../infra/gateway-lock.js";
import { routeLogsToStderr } from "../logging/console.js";
import {
  startOneShotDiagnosticsExporters,
  type OneShotDiagnosticsHandle,
} from "../plugins/one-shot-diagnostics.js";
import {
  buildAgentMainSessionKey,
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import { normalizeMessageChannel } from "../utils/message-channel-normalize.js";

type AgentGatewayResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string | null;
    mediaUrls?: string[];
  }>;
  deliveryStatus?: unknown;
  meta?: unknown;
};

type GatewayAgentResponse = {
  runId?: string;
  status?: string;
  summary?: string;
  result?: AgentGatewayResult;
  deliveryStatus?: unknown;
};

const NO_GATEWAY_TIMEOUT_MS = 2_147_000_000;
const GATEWAY_TRANSIENT_CONNECT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const;

type AgentCliOpts = {
  message?: string;
  messageFile?: string;
  agent?: string;
  model?: string;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  thinking?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  channel?: string;
  replyTo?: string;
  replyChannel?: string;
  replyAccount?: string;
  bestEffortDeliver?: boolean;
  lane?: string;
  runId?: string;
  extraSystemPrompt?: string;
  local?: boolean;
};
type RemoteGatewayRoster = {
  agentIds: string[];
  defaultId: string;
  ownership?: AgentsListResult["ownership"];
  selectionRequired: boolean;
  mainKey: string;
  scope: AgentsListResult["scope"];
};
type AgentDispatchOpts = Omit<AgentCliOpts, "messageFile"> & {
  message: string;
  gatewayDispatchConfig?: OpenClawConfig;
  remoteGatewayRoster?: RemoteGatewayRoster;
  localGatewayCompatibilityAgentId?: string;
};

type AgentCliSignal = EmbeddedStateSignal;
type AgentCliProcessLike = EmbeddedStateSignalProcess & {
  exitCode?: NodeJS.Process["exitCode"];
};
type AgentCliDeps = CliDeps & {
  process?: AgentCliProcessLike;
  localGatewayLockOptions?: GatewayLockOptions;
};
type AgentGatewayCallIdentity = Pick<
  Parameters<typeof callGateway>[0],
  "clientName" | "mode" | "scopes"
>;
type AgentSessionModule = typeof import("./agent/session.runtime.js");
type AgentSessionModuleLoader = () => Promise<AgentSessionModule>;

function usesImplicitRemoteCompatibilityDefault(roster: RemoteGatewayRoster): boolean {
  return (
    !roster.selectionRequired &&
    (roster.ownership === "legacy" || (!roster.ownership && roster.agentIds.length > 1))
  );
}

function resolveImplicitCliAgentId(cfg: OpenClawConfig, remote?: RemoteGatewayRoster): string {
  const migratedConfig = remote
    ? cfg
    : (migratePersistedImplicitMainRoster(cfg).config as OpenClawConfig);
  const selectionCfg = remote
    ? cfg
    : inheritLegacyDefaultAgentId(
        tryGetLegacyDefaultAgentId(cfg) ? cfg : migratedConfig,
        migratedConfig,
      );
  const selected = remote
    ? remote.selectionRequired
      ? undefined
      : remote.defaultId
    : tryResolveLegacyCompatibilityAgentId(selectionCfg);
  if (selected) {
    return selected;
  }
  const agentIds = remote?.agentIds ?? listAgentIds(selectionCfg);
  throw new AgentSelectionRequiredError(agentIds, {
    surface: "agent turn",
    hint: `Pass --agent <id> to select one of: ${agentIds.join(", ")}.`,
  });
}

const GATEWAY_ABORT_RETRY_DELAYS_MS = [50, 150, 300, 600] as const;
const GATEWAY_ABORT_REQUEST_TIMEOUT_MS = 2_000;
const AGENT_CLI_SIGNAL_EXIT_CODES: Record<AgentCliSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};
const MESSAGE_FILE_DECODER = new TextDecoder("utf-8", { fatal: true });

const defaultAgentSessionModuleLoader: AgentSessionModuleLoader = () =>
  import("./agent/session.runtime.js");
let agentSessionModuleLoader: AgentSessionModuleLoader = defaultAgentSessionModuleLoader;
const embeddedAgentCommandLoader = createLazyPromiseLoader(
  () => import("./agent.js").then((module) => module.agentCommand),
  { cacheRejections: true },
);
const localAuditModuleLoader = createLazyPromiseLoader(() => import("./agent-local-audit.js"), {
  cacheRejections: true,
});
const agentSessionModuleCache = createLazyPromiseLoader(() => agentSessionModuleLoader(), {
  cacheRejections: true,
});
const runtimeConfigModuleLoader = createLazyPromiseLoader(() => import("../config/io.js"), {
  cacheRejections: true,
});
const embeddedStateLockModuleLoader = createLazyPromiseLoader(
  () => import("../infra/embedded-state-lock.js"),
  { cacheRejections: true },
);
const replyPayloadModuleLoader = createLazyPromiseLoader(
  () => import("openclaw/plugin-sdk/reply-payload"),
  { cacheRejections: true },
);
let gatewayAbortRetryDelaysMsForTests: readonly number[] | undefined;

function resolveGatewayAbortRetryDelaysMs(): readonly number[] {
  return gatewayAbortRetryDelaysMsForTests ?? GATEWAY_ABORT_RETRY_DELAYS_MS;
}

const loadAgentSessionModule = agentSessionModuleCache.load;

type EmbeddedAgentCommandOpts = Parameters<
  Awaited<ReturnType<typeof embeddedAgentCommandLoader.load>>
>[0];
type EmbeddedRunDiagnosticsOptions = {
  suppressStdoutDiagnosticLogs: boolean;
};

async function startEmbeddedRunDiagnosticsExporters(
  runtime: RuntimeEnv,
  options: EmbeddedRunDiagnosticsOptions,
  config: OpenClawConfig,
): Promise<OneShotDiagnosticsHandle | null> {
  try {
    return await startOneShotDiagnosticsExporters({
      config,
      suppressStdoutDiagnosticLogs: options.suppressStdoutDiagnosticLogs,
    });
  } catch (err) {
    // Exporter startup must never break the agent run itself.
    runtime.error?.(`diagnostics exporter startup failed for embedded run: ${String(err)}`);
    return null;
  }
}

/**
 * Run the embedded agent command with OTel diagnostics export for this
 * one-shot process: the Gateway only starts diagnostics exporters in its own
 * process, so embedded runs start one here and flush it before the CLI exits
 * (including signal exits, which happen after this returns).
 */
async function runEmbeddedAgentCommand(
  opts: EmbeddedAgentCommandOpts,
  runtime: RuntimeEnv,
  deps: AgentCliDeps | undefined,
  diagnosticsOptions: EmbeddedRunDiagnosticsOptions,
) {
  const agentCommand = await measureAgentStartup("command-import", () =>
    embeddedAgentCommandLoader.load(),
  );
  const config = await loadRuntimeConfig();
  const diagnostics = await startEmbeddedRunDiagnosticsExporters(
    runtime,
    diagnosticsOptions,
    config,
  );
  let stopLocalAuditWriter: (() => Promise<void>) | undefined;
  if (isExecutionIdentityCollectionEnabled(config)) {
    try {
      stopLocalAuditWriter = (await localAuditModuleLoader.load()).startAgentLocalAuditWriter();
    } catch {
      // Admission emits one bounded warning if evidence cannot be queued.
    }
  }
  try {
    return await agentCommand(opts, runtime, deps);
  } finally {
    await Promise.all([diagnostics?.stop(), stopLocalAuditWriter?.().catch(() => undefined)]);
  }
}

async function loadRuntimeConfig(): Promise<OpenClawConfig> {
  const { getRuntimeConfig } = await runtimeConfigModuleLoader.load();
  return getRuntimeConfig();
}

function usesRemoteGateway(cfg: OpenClawConfig): boolean {
  return Boolean(
    cfg.gateway?.mode === "remote" || normalizeOptionalString(process.env.OPENCLAW_GATEWAY_URL),
  );
}

async function loadRemoteGatewayRoster(cfg: OpenClawConfig): Promise<RemoteGatewayRoster> {
  const result = await callGateway<AgentsListResult>({
    method: "agents.list",
    params: {},
    config: cfg,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
    scopes: [READ_SCOPE],
  });
  const agentIds = result.agents
    .filter((entry) => entry.kind !== "system")
    .map((entry) => normalizeAgentId(entry.id));
  return {
    agentIds,
    defaultId: normalizeAgentId(result.defaultId),
    ownership: result.ownership,
    selectionRequired: result.selectionRequired ?? result.ownership === "explicit",
    mainKey: result.mainKey,
    scope: result.scope,
  };
}

async function loadRemoteGatewayRosterWithShellEnvFallback(
  cfg: OpenClawConfig,
): Promise<{ config: OpenClawConfig; roster: RemoteGatewayRoster }> {
  try {
    return { config: cfg, roster: await loadRemoteGatewayRoster(cfg) };
  } catch (error) {
    if (!shouldRetryGatewayDispatchWithShellEnvFallback(error)) {
      throw error;
    }
    const fallbackConfig = await readGatewayDispatchConfigWithShellEnvFallback();
    return {
      config: fallbackConfig,
      roster: await loadRemoteGatewayRoster(fallbackConfig),
    };
  }
}

function formatActiveGatewayLocalRefusal(identity: GatewayLockIdentity): string {
  return `A Gateway is running for this state directory (pid ${identity.pid}, port ${identity.port}). Run without --local to use it, or stop the Gateway first (${formatCliCommand("openclaw gateway stop")}).`;
}

async function acquireEmbeddedAgentStateLock(
  options: GatewayLockOptions | undefined,
  signal: AbortSignal,
) {
  const { acquireEmbeddedStateLock } = await embeddedStateLockModuleLoader.load();
  return await acquireEmbeddedStateLock({
    options,
    signal,
    formatActiveGatewayRefusal: formatActiveGatewayLocalRefusal,
  });
}

const loadReplyPayloadModule = replyPayloadModuleLoader.load;

/** Test-only hooks for resetting lazy imports and shortening retry timing. */
export const agentViaGatewayTesting = {
  resetLazyImportsForTests(): void {
    embeddedAgentCommandLoader.clear();
    localAuditModuleLoader.clear();
    agentSessionModuleCache.clear();
    runtimeConfigModuleLoader.clear();
    embeddedStateLockModuleLoader.clear();
    replyPayloadModuleLoader.clear();
    agentSessionModuleLoader = defaultAgentSessionModuleLoader;
  },
  setAgentSessionModuleLoaderForTests(loader: AgentSessionModuleLoader): void {
    agentSessionModuleCache.clear();
    agentSessionModuleLoader = loader;
  },
  setGatewayAbortRetryDelaysMsForTests(delays?: readonly number[]): void {
    gatewayAbortRetryDelaysMsForTests = delays;
  },
};

function protectJsonStdout(opts: Pick<AgentCliOpts, "json">): void {
  if (opts.json === true) {
    routeLogsToStderr();
  }
}

function missingAgentMessageError(): Error {
  return new Error(
    `Missing message. Use ${formatCliCommand('openclaw agent --message "..." --agent <id>')} or ${formatCliCommand("openclaw agent --message-file <path> --agent <id>")}.`,
  );
}

function formatMessageFileReadFailure(messageFile: string, err: unknown): string {
  const code =
    typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
  if (code === "ENOENT") {
    return `Message file not found: ${messageFile}`;
  }
  if (code === "EISDIR") {
    return `Message file is a directory: ${messageFile}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Unable to read message file ${messageFile}: ${message}`;
}

// Agent messages are prompt text; a 4 MiB cap gives generous headroom for
// long system prompts while preventing a symlink/huge-file path from OOMing
// the CLI before dispatch.
const AGENT_MESSAGE_FILE_MAX_BYTES = 4 * 1024 * 1024;

async function readAgentMessageFile(messageFile: string): Promise<string> {
  // Open the original path so the kernel preserves symlink and procfs magic-link
  // behavior (notably piped /dev/stdin), then inspect that exact descriptor.
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(messageFile, "r");
  } catch (err) {
    throw new Error(formatMessageFileReadFailure(messageFile, err), { cause: err });
  }
  let buffer: Buffer;
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) {
      // Keep the legacy fs.readFile directory UX.
      throw Object.assign(new Error("Message file is a directory"), { code: "EISDIR" });
    }
    // Regular files fail fast. Streams report size 0, so the descriptor reader
    // enforces the same limit byte-by-byte while preserving FIFO behavior.
    if (stat.isFile() && stat.size > AGENT_MESSAGE_FILE_MAX_BYTES) {
      throw new Error(`File exceeds ${AGENT_MESSAGE_FILE_MAX_BYTES} bytes: ${messageFile}`);
    }
    buffer = await readFileDescriptorBounded(handle.fd, AGENT_MESSAGE_FILE_MAX_BYTES);
  } catch (err) {
    throw new Error(formatMessageFileReadFailure(messageFile, err), { cause: err });
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    return MESSAGE_FILE_DECODER.decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    throw new Error(`Message file must be valid UTF-8: ${messageFile}`);
  }
}

async function resolveAgentMessageOpts(opts: AgentCliOpts): Promise<AgentDispatchOpts> {
  const { messageFile: rawMessageFile, ...rest } = opts;
  const messageFile = rawMessageFile?.trim();
  const hasInlineMessage = opts.message !== undefined;
  if (hasInlineMessage && messageFile) {
    throw new Error("Use either --message or --message-file, not both.");
  }
  if (rawMessageFile !== undefined && !messageFile) {
    throw new Error("--message-file must not be empty.");
  }
  if (messageFile) {
    const message = await readAgentMessageFile(messageFile);
    if (!message.trim()) {
      throw new Error(`Message file is empty: ${messageFile}`);
    }
    return { ...rest, message };
  }
  const message = opts.message ?? "";
  if (!message.trim()) {
    throw missingAgentMessageError();
  }
  return { ...rest, message };
}

function parseTimeoutSeconds(opts: { cfg: OpenClawConfig; timeout?: string }) {
  const raw =
    opts.timeout !== undefined
      ? parseStrictNonNegativeInteger(opts.timeout)
      : (opts.cfg.agents?.defaults?.timeoutSeconds ?? 600);
  if (raw === undefined) {
    throw new Error(
      `Invalid --timeout. Use seconds as a non-negative integer, for example --timeout 600. Use --timeout 0 to disable the timeout.`,
    );
  }
  return raw;
}

function resolveGatewayAgentTimeoutMs(timeoutSeconds: number): number {
  if (timeoutSeconds === 0) {
    return NO_GATEWAY_TIMEOUT_MS;
  }
  return resolveTimerTimeoutMs((timeoutSeconds + 30) * 1000, 10_000, 10_000);
}

async function formatPayloadForLog(payload: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string | null;
}) {
  const { resolveSendableOutboundReplyParts } = await loadReplyPayloadModule();
  const parts = resolveSendableOutboundReplyParts({
    text: payload.text,
    mediaUrls: payload.mediaUrls,
    mediaUrl: typeof payload.mediaUrl === "string" ? payload.mediaUrl : undefined,
  });
  const lines: string[] = [];
  if (parts.text) {
    lines.push(parts.text.trimEnd());
  }
  for (const url of parts.mediaUrls) {
    lines.push(`Attachment: ${url}`);
  }
  return lines.join("\n").trimEnd();
}

function isCompactControlCommand(message: string): boolean {
  return /^\/compact(?:\s|:|$)/iu.test(message.trim());
}

function isSessionResetCommand(message: string): boolean {
  return /^\/(?:new|reset)(?:\s|$)/i.test(message.trim());
}

function shouldRetryGatewayDispatchWithShellEnvFallback(err: unknown): boolean {
  return (
    isGatewayCredentialsRequiredError(err) ||
    isGatewayExplicitAuthRequiredError(err) ||
    isGatewaySecretRefUnavailableError(err)
  );
}

function resolveGatewayAgentFailureHint(
  err: unknown,
): "timed out" | "connection closed" | undefined {
  if (!isGatewayTransportError(err)) {
    return undefined;
  }
  // callGateway's wrapper timer gives this CLI path typed transport errors.
  // Legacy request-timeout strings belong to lower-level and in-process callers.
  return err.kind === "timeout" ? "timed out" : "connection closed";
}

function isTransientGatewayAgentConnectClose(err: unknown): boolean {
  if (!isGatewayTransportError(err) || err.kind !== "closed") {
    return false;
  }
  const code = typeof err.code === "number" ? err.code : undefined;
  const reason = normalizeOptionalString(err.reason);
  return code === 1000 && (!reason || reason === "no close reason");
}

function validateExplicitSessionKeyForDispatch(
  opts: Pick<AgentCliOpts, "agent" | "sessionKey">,
): void {
  const sessionKey = opts.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }

  if (classifySessionKeyShape(sessionKey) === "malformed_agent") {
    throw new Error(
      `Invalid --session-key "${sessionKey}". Agent-prefixed session keys must use agent:<agent-id>:<session-key>.`,
    );
  }

  const agentIdRaw = opts.agent?.trim() || undefined;
  if (!agentIdRaw || classifySessionKeyShape(sessionKey) !== "agent") {
    return;
  }
  const agentId = normalizeAgentId(agentIdRaw);
  const sessionAgentId = resolveAgentIdFromSessionKey(sessionKey);
  if (sessionAgentId !== agentId) {
    throw new Error(
      `Agent id "${agentIdRaw}" does not match session key agent "${sessionAgentId}".`,
    );
  }
}

async function normalizeSessionKeyOptsForDispatch(
  opts: AgentDispatchOpts,
): Promise<AgentDispatchOpts> {
  let normalizedOpts = opts;
  const rawSessionKey = opts.sessionKey?.trim();
  const rawTo = opts.to?.trim();
  if (!rawSessionKey && !opts.sessionId?.trim() && classifySessionKeyShape(rawTo) === "agent") {
    return normalizeSessionKeyOptsForDispatch({ ...opts, to: undefined, sessionKey: rawTo });
  }
  const isLegacySessionKey =
    rawSessionKey && classifySessionKeyShape(rawSessionKey) === "legacy_or_alias";
  const explicitAgentIdRaw = opts.agent?.trim();
  let agentIdRaw = explicitAgentIdRaw;
  const hasExplicitSessionTarget =
    Boolean(opts.sessionId?.trim()) ||
    [rawSessionKey, rawTo].some((value) => classifySessionKeyShape(value) === "agent");
  let selectionCfg: OpenClawConfig | undefined;
  let remoteGatewayRoster: RemoteGatewayRoster | undefined;
  if (opts.local !== true) {
    const cfg = readGatewayDispatchConfig();
    normalizedOpts = { ...normalizedOpts, gatewayDispatchConfig: cfg };
    selectionCfg = cfg;
    if (
      rawSessionKey &&
      usesRemoteGateway(cfg) &&
      classifySessionKeyShape(rawSessionKey) !== "agent"
    ) {
      // The remote gateway owns its roster and durable session-store metadata. Forward bare keys
      // unchanged, even with an explicit agent, so stale local state cannot rewrite the target.
      return normalizedOpts;
    }
  }
  if (!agentIdRaw && !hasExplicitSessionTarget && !(opts.local === true && rawTo)) {
    let cfg =
      opts.local === true
        ? await loadRuntimeConfig()
        : (selectionCfg ?? readGatewayDispatchConfig());
    if (opts.local !== true && usesRemoteGateway(cfg)) {
      const loaded = await loadRemoteGatewayRosterWithShellEnvFallback(cfg);
      cfg = loaded.config;
      remoteGatewayRoster = loaded.roster;
      normalizedOpts = { ...normalizedOpts, gatewayDispatchConfig: cfg, remoteGatewayRoster };
    }
    selectionCfg = cfg;
    const effectiveOwnerSessionKey =
      rawSessionKey ?? (cfg.session?.scope === "global" ? "global" : undefined);
    const persistedKeyOwner = remoteGatewayRoster
      ? ({ kind: "none" } as const)
      : resolvePersistedSessionStoreOwnerForKey(cfg, effectiveOwnerSessionKey);
    if (persistedKeyOwner.kind === "retired") {
      throw new AgentSelectionRequiredError(listAgentIds(cfg), {
        surface: `session key "${rawSessionKey}"`,
        hint: `The shared fixed-store row belongs to retired agent "${persistedKeyOwner.agentId}".`,
      });
    }
    if (
      persistedKeyOwner.kind === "configured" &&
      rawSessionKey === undefined &&
      effectiveOwnerSessionKey === "global"
    ) {
      normalizedOpts = { ...normalizedOpts, sessionKey: "global" };
    }
    const selectedAgentId =
      persistedKeyOwner.kind === "configured"
        ? persistedKeyOwner.agentId
        : resolveImplicitCliAgentId(cfg, remoteGatewayRoster);
    const implicitSoleAgent = remoteGatewayRoster
      ? remoteGatewayRoster.ownership === "sole" ||
        (!remoteGatewayRoster.ownership && remoteGatewayRoster.agentIds.length === 1)
      : tryResolveSoleAgentId(cfg) === selectedAgentId;
    const implicitCompatibilityDefault = remoteGatewayRoster
      ? usesImplicitRemoteCompatibilityDefault(remoteGatewayRoster)
      : !implicitSoleAgent;
    const implicitGlobalSession =
      !explicitAgentIdRaw &&
      rawSessionKey === undefined &&
      (remoteGatewayRoster
        ? remoteGatewayRoster.scope === "global"
        : (opts.local === true || !usesRemoteGateway(cfg)) && cfg.session?.scope === "global");
    const unscopedSession = isUnscopedSessionKeySentinel(rawSessionKey) || implicitGlobalSession;
    const implicitAgentSelection = implicitSoleAgent || implicitCompatibilityDefault;
    agentIdRaw = implicitAgentSelection && unscopedSession ? undefined : selectedAgentId;
    if (!remoteGatewayRoster && implicitCompatibilityDefault) {
      // The retained owner lives on the migrated config sidecar, so carry it past
      // normalization rather than re-deriving ownership from the raw dispatch config.
      normalizedOpts = {
        ...normalizedOpts,
        localGatewayCompatibilityAgentId: selectedAgentId,
      };
    }
    if (agentIdRaw && implicitCompatibilityDefault && !rawSessionKey && !rawTo) {
      // Legacy multi-agent owners stay implicit, but a bare per-sender turn still
      // needs their canonical main session to reach gateway dispatch.
      normalizedOpts = {
        ...normalizedOpts,
        sessionKey: buildAgentMainSessionKey({
          agentId: selectedAgentId,
          mainKey: remoteGatewayRoster?.mainKey ?? cfg.session?.mainKey,
        }),
      };
    } else if (agentIdRaw && !implicitCompatibilityDefault) {
      normalizedOpts = {
        ...normalizedOpts,
        agent: selectedAgentId,
      };
    }
  }
  const shouldScopeDefaultAgentKey =
    isLegacySessionKey && !agentIdRaw && !isUnscopedSessionKeySentinel(rawSessionKey);
  const cfg =
    isLegacySessionKey && (agentIdRaw || shouldScopeDefaultAgentKey)
      ? normalizedOpts.local === true
        ? await loadRuntimeConfig()
        : (selectionCfg ?? readGatewayDispatchConfig())
      : undefined;
  const persistedBareOwner =
    cfg && rawSessionKey && isLegacySessionKey && !isUnscopedSessionKeySentinel(rawSessionKey)
      ? resolvePersistedSessionStoreOwnerForKey(cfg, rawSessionKey)
      : undefined;
  if (persistedBareOwner?.kind === "configured") {
    // Fixed-store rows keep their durable bare key. The selected owner travels separately so
    // request-time resolution can validate it without changing the storage identity.
    return normalizedOpts;
  }
  const sessionKey = scopeLegacySessionKeyToAgent({
    agentId: agentIdRaw,
    sessionKey: normalizedOpts.sessionKey,
    mainKey: remoteGatewayRoster?.mainKey ?? cfg?.session?.mainKey,
  });
  if (sessionKey === normalizedOpts.sessionKey) {
    return normalizedOpts;
  }
  return {
    ...normalizedOpts,
    sessionKey,
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function readAcceptedRunContext(payload: unknown): {
  runId?: string;
  sessionKey?: string;
  agentId?: string;
} {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const runId = (payload as { runId?: unknown }).runId;
  const sessionKey = (payload as { sessionKey?: unknown }).sessionKey;
  const agentId = (payload as { agentId?: unknown }).agentId;
  const status = (payload as { status?: unknown }).status;
  if (status !== "accepted") {
    return {};
  }
  return {
    runId: typeof runId === "string" && runId.trim() ? runId.trim() : undefined,
    sessionKey: typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : undefined,
    agentId: typeof agentId === "string" && agentId.trim() ? agentId.trim() : undefined,
  };
}

function createAgentCliSignalBridge(processLike: AgentCliProcessLike = process) {
  const bridge = createEmbeddedStateSignalBridge(processLike);
  return {
    ...bridge,
    setExitCode: (code: number) => {
      processLike.exitCode = code;
    },
  };
}

function isAgentCliProcessLike(value: unknown): value is AgentCliProcessLike {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { on?: unknown }).on === "function" &&
    typeof (value as { off?: unknown }).off === "function"
  );
}

function resolveAgentCliProcessLike(deps: AgentCliDeps | undefined): AgentCliProcessLike {
  if (!deps || !Object.hasOwn(deps, "process")) {
    return process;
  }
  const processLike = (deps as { process?: unknown }).process;
  return isAgentCliProcessLike(processLike) ? processLike : process;
}

function createAbortDelayError(): Error {
  return createAbortError("gateway agent retry aborted");
}

function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortDelayError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortDelayError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isConfirmedChatAbortResponseForRun(value: unknown, runId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const response = value as { aborted?: unknown; runIds?: unknown };
  if (response.aborted !== true) {
    return false;
  }
  if (response.runIds === undefined) {
    return true;
  }
  return Array.isArray(response.runIds) && response.runIds.includes(runId);
}

async function abortAcceptedGatewayAgentRunWithRequest(params: {
  runId: string | undefined;
  sessionKey: string | undefined;
  agentId?: string;
  signal: AgentCliSignal | undefined;
  runtime: RuntimeEnv;
  request: GatewayRequestFunction;
  logFailure?: boolean;
}): Promise<boolean> {
  if (!params.signal || !params.runId || !params.sessionKey) {
    return false;
  }
  try {
    const response = await params.request(
      "chat.abort",
      {
        sessionKey: params.sessionKey,
        runId: params.runId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
      },
      { timeoutMs: GATEWAY_ABORT_REQUEST_TIMEOUT_MS },
    );
    if (isConfirmedChatAbortResponseForRun(response, params.runId)) {
      return true;
    }
    if (params.logFailure !== false) {
      params.runtime.error?.(
        `Interrupted by ${params.signal}; Gateway run ${params.runId} was not confirmed aborted.`,
      );
    }
    return false;
  } catch (err) {
    if (params.logFailure !== false) {
      params.runtime.error?.(
        `Interrupted by ${params.signal}; failed to abort Gateway run ${params.runId}: ${String(
          err,
        )}`,
      );
    }
    return false;
  }
}

async function abortAcceptedGatewayAgentRunWithGatewayCall(params: {
  runId: string | undefined;
  sessionKey: string | undefined;
  agentId?: string;
  signal: AgentCliSignal | undefined;
  runtime: RuntimeEnv;
  gatewayIdentity: AgentGatewayCallIdentity;
  config: OpenClawConfig;
}): Promise<void> {
  const request: GatewayRequestFunction = async <T = Record<string, unknown>>(
    method: string,
    requestParams?: unknown,
    opts?: Parameters<GatewayRequestFunction>[2],
  ): Promise<T> =>
    await callGateway<T>({
      method,
      params: requestParams,
      timeoutMs: opts?.timeoutMs ?? undefined,
      expectFinal: opts?.expectFinal,
      config: params.config,
      ...params.gatewayIdentity,
    });
  const retryDelaysMs = resolveGatewayAbortRetryDelaysMs();
  for (const [attempt, retryDelayMs] of [...retryDelaysMs, 0].entries()) {
    const isFinalAttempt = attempt === retryDelaysMs.length;
    const aborted = await abortAcceptedGatewayAgentRunWithRequest({
      runId: params.runId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      signal: params.signal,
      runtime: params.runtime,
      request,
      logFailure: isFinalAttempt,
    });
    if (aborted || isFinalAttempt) {
      return;
    }
    await delayMs(retryDelayMs);
  }
}

async function abortAcceptedGatewayAgentRunOnActiveConnection(params: {
  runId: string | undefined;
  sessionKey: string | undefined;
  agentId?: string;
  signal: AgentCliSignal | undefined;
  runtime: RuntimeEnv;
  request: GatewayRequestFunction;
}): Promise<boolean> {
  const retryDelaysMs = resolveGatewayAbortRetryDelaysMs();
  for (const [attempt, retryDelayMs] of [...retryDelaysMs, 0].entries()) {
    const isFinalAttempt = attempt === retryDelaysMs.length;
    const aborted = await abortAcceptedGatewayAgentRunWithRequest({
      runId: params.runId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      signal: params.signal,
      runtime: params.runtime,
      request: params.request,
      logFailure: false,
    });
    if (aborted || isFinalAttempt) {
      return aborted;
    }
    await delayMs(retryDelayMs);
  }
  return false;
}

function exitForReceivedSignal(signal: AgentCliSignal | undefined, runtime: RuntimeEnv): boolean {
  if (!signal) {
    return false;
  }
  runtime.exit(AGENT_CLI_SIGNAL_EXIT_CODES[signal]);
  return true;
}

function returnAfterSignalExit<T>(
  value: T,
  signal: AgentCliSignal | undefined,
  runtime: RuntimeEnv,
): T | undefined {
  return exitForReceivedSignal(signal, runtime) ? undefined : value;
}

function buildGatewayJsonResponse(response: GatewayAgentResponse): GatewayAgentResponse {
  const deliveryStatus = response.result?.deliveryStatus;
  if (deliveryStatus === undefined) {
    return response;
  }
  return {
    ...response,
    deliveryStatus,
  };
}

function isInFlightGatewayAgentResponse(response: GatewayAgentResponse): boolean {
  return response.status === "in_flight";
}

function markFailedGatewayAgentResponse(
  response: GatewayAgentResponse,
  signalBridge: ReturnType<typeof createAgentCliSignalBridge>,
): void {
  if (
    response.status === "timeout" ||
    response.status === "error" ||
    response.status === "cancelled"
  ) {
    // Let Node drain structured or text stdout before the process exits.
    signalBridge.setExitCode(1);
  }
}

function formatInFlightGatewayAgentMessage(response: GatewayAgentResponse): string {
  return response.runId
    ? `Agent run ${response.runId} is already in flight; not starting a duplicate run.`
    : "Agent run is already in flight; not starting a duplicate run.";
}

async function agentViaGatewayCommand(
  opts: AgentDispatchOpts,
  runtime: RuntimeEnv,
  signalBridge: ReturnType<typeof createAgentCliSignalBridge>,
) {
  const body = opts.message;
  const explicitSessionKey = opts.sessionKey?.trim();
  let cfg: OpenClawConfig = opts.gatewayDispatchConfig ?? readGatewayDispatchConfig();
  const remoteGateway = usesRemoteGateway(cfg);
  const remoteRosterIsSole =
    opts.remoteGatewayRoster?.ownership === "sole" ||
    (!opts.remoteGatewayRoster?.ownership && opts.remoteGatewayRoster?.agentIds.length === 1);
  const remoteRosterUsesCompatibilityDefault = Boolean(
    opts.remoteGatewayRoster && usesImplicitRemoteCompatibilityDefault(opts.remoteGatewayRoster),
  );
  const hasImplicitGlobalTarget =
    (opts.remoteGatewayRoster?.scope ?? cfg.session?.scope) === "global" &&
    (opts.remoteGatewayRoster
      ? !opts.remoteGatewayRoster.selectionRequired &&
        (remoteRosterIsSole || remoteRosterUsesCompatibilityDefault)
      : !remoteGateway &&
        (tryResolveSoleAgentId(cfg) !== undefined ||
          opts.localGatewayCompatibilityAgentId !== undefined));
  if (
    !opts.to &&
    !opts.sessionId &&
    !opts.agent &&
    !explicitSessionKey &&
    !hasImplicitGlobalTarget
  ) {
    throw new Error(
      `No target session selected. Use --agent <id>, --session-key <key>, --session-id <id>, or --to <E.164>. Run ${formatCliCommand("openclaw agents list")} to see agents.`,
    );
  }

  // Scoped gateway turns need core agent/session/gateway fields only. The
  // running gateway owns plugin validation and plugin metadata freshness.
  const agentIdRaw = opts.agent?.trim();
  const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
  if (agentId) {
    const knownAgents =
      opts.remoteGatewayRoster?.agentIds ?? (remoteGateway ? undefined : listAgentIds(cfg));
    if (knownAgents && !knownAgents.includes(agentId)) {
      throw new Error(
        `Unknown agent id "${agentIdRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
      );
    }
  }
  const timeoutSeconds = parseTimeoutSeconds({ cfg, timeout: opts.timeout });
  const gatewayTimeoutMs = resolveGatewayAgentTimeoutMs(timeoutSeconds);
  const channel = normalizeMessageChannel(opts.channel);
  const deferExplicitRecipientSession = Boolean(
    !explicitSessionKey &&
    !opts.sessionId?.trim() &&
    agentId &&
    channel &&
    channel !== "last" &&
    opts.to?.trim() &&
    classifySessionKeyShape(opts.to) !== "agent",
  );
  const deferRemoteSessionId = Boolean(
    remoteGateway && opts.sessionId?.trim() && !explicitSessionKey,
  );
  const deferRemoteBareSessionKey = Boolean(
    remoteGateway && explicitSessionKey && classifySessionKeyShape(explicitSessionKey) !== "agent",
  );
  const deferAgentDefaultSession = Boolean(
    agentId && !explicitSessionKey && !opts.sessionId?.trim() && !opts.to?.trim(),
  );
  const preserveImplicitCompatibilitySession =
    (remoteRosterIsSole || remoteRosterUsesCompatibilityDefault) &&
    !agentId &&
    (isUnscopedSessionKeySentinel(explicitSessionKey) || hasImplicitGlobalTarget);

  const sessionKey =
    preserveImplicitCompatibilitySession || deferRemoteBareSessionKey
      ? explicitSessionKey
      : deferAgentDefaultSession || deferExplicitRecipientSession || deferRemoteSessionId
        ? undefined
        : classifySessionKeyShape(explicitSessionKey) === "agent"
          ? explicitSessionKey
          : (await loadAgentSessionModule()).resolveSessionKeyForRequest({
              cfg,
              agentId,
              to: opts.to,
              sessionId: opts.sessionId,
              sessionKey: explicitSessionKey,
            }).sessionKey;
  const abortSessionKey = deferRemoteSessionId
    ? undefined
    : deferExplicitRecipientSession
      ? (await loadAgentSessionModule()).resolveSessionKeyForRequest({ cfg, agentId }).sessionKey
      : sessionKey;

  const idempotencyKey = normalizeOptionalString(opts.runId) || randomIdempotencyKey();
  const modelOverride = normalizeOptionalString(opts.model);
  const hasModelOverride = Boolean(modelOverride);
  const needsAdminGatewayIdentity = hasModelOverride || isSessionResetCommand(body);
  const gatewayIdentity: AgentGatewayCallIdentity = needsAdminGatewayIdentity
    ? {
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: [ADMIN_SCOPE],
      }
    : {
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        // The local CLI is the Gateway owner. Keep owner-only run tools available;
        // remote clients retain the agent method's least-privilege scope.
        ...(remoteGateway ? {} : { scopes: [ADMIN_SCOPE] }),
      };

  let acceptedRunId: string | undefined = idempotencyKey;
  let acceptedSessionKey: string | undefined = abortSessionKey;
  let acceptedAgentId: string | undefined;
  let acceptedGatewayRun = false;
  let activeConnectionAbortAttempted = false;
  let activeConnectionAbortSucceeded = false;
  let response: GatewayAgentResponse | undefined;
  const dispatchGatewayAgentCall = async (activeCfg: OpenClawConfig) =>
    await withProgress(
      {
        label: "Waiting for agent reply…",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway({
          method: "agent",
          params: {
            message: body,
            agentId,
            model: modelOverride,
            to: opts.to,
            replyTo: opts.replyTo,
            sessionId: opts.sessionId,
            sessionKey,
            thinking: opts.thinking,
            deliver: Boolean(opts.deliver),
            channel,
            replyChannel: opts.replyChannel,
            replyAccountId: opts.replyAccount,
            bestEffortDeliver: opts.bestEffortDeliver,
            timeout: timeoutSeconds,
            lane: opts.lane,
            extraSystemPrompt: opts.extraSystemPrompt,
            cleanupBundleMcpOnRunEnd: true,
            idempotencyKey,
          },
          expectFinal: true,
          timeoutMs: gatewayTimeoutMs,
          config: activeCfg,
          signal: signalBridge.signal,
          onAccepted: (payload) => {
            acceptedGatewayRun = true;
            const accepted = readAcceptedRunContext(payload);
            acceptedRunId = accepted.runId ?? acceptedRunId;
            acceptedSessionKey = accepted.sessionKey ?? acceptedSessionKey;
            acceptedAgentId = accepted.agentId;
          },
          onSignalAbort: async (request) => {
            activeConnectionAbortAttempted = true;
            activeConnectionAbortSucceeded = await abortAcceptedGatewayAgentRunOnActiveConnection({
              runId: acceptedRunId,
              sessionKey: acceptedSessionKey,
              agentId: acceptedAgentId,
              signal: signalBridge.getReceivedSignal(),
              runtime,
              request,
            });
          },
          ...gatewayIdentity,
        }),
    );

  let shellEnvFallbackRetriesRemaining = 1;
  const consumeShellEnvFallbackRetry = () => shellEnvFallbackRetriesRemaining-- > 0;
  for (;;) {
    try {
      response = await dispatchGatewayAgentCall(cfg);
      break;
    } catch (err) {
      if (
        !acceptedGatewayRun &&
        shouldRetryGatewayDispatchWithShellEnvFallback(err) &&
        consumeShellEnvFallbackRetry()
      ) {
        cfg = await readGatewayDispatchConfigWithShellEnvFallback();
        continue;
      }
      if (
        isAbortError(err) &&
        !activeConnectionAbortSucceeded &&
        (acceptedGatewayRun || activeConnectionAbortAttempted)
      ) {
        await abortAcceptedGatewayAgentRunWithGatewayCall({
          runId: acceptedRunId,
          sessionKey: acceptedSessionKey,
          agentId: acceptedAgentId,
          signal: signalBridge.getReceivedSignal(),
          runtime,
          gatewayIdentity,
          config: cfg,
        });
      }
      throw err;
    }
  }
  if (!response) {
    throw new Error("gateway agent call did not return a response");
  }

  if (opts.json) {
    writeRuntimeJson(runtime, buildGatewayJsonResponse(response));
    markFailedGatewayAgentResponse(response, signalBridge);
    return response;
  }

  const result = response?.result;
  const payloads = result?.payloads ?? [];

  if (isInFlightGatewayAgentResponse(response)) {
    runtime.error?.(formatInFlightGatewayAgentMessage(response));
    return response;
  }

  if (payloads.length === 0) {
    if (response?.status !== "ok") {
      runtime.log(response?.summary ? response.summary : "No reply from agent.");
    }
    markFailedGatewayAgentResponse(response, signalBridge);
    return response;
  }

  for (const payload of payloads) {
    const out = await formatPayloadForLog(payload);
    if (out) {
      runtime.log(out);
    }
  }

  markFailedGatewayAgentResponse(response, signalBridge);

  return response;
}

async function agentViaGatewayCommandWithTransientRetries(
  opts: AgentDispatchOpts,
  runtime: RuntimeEnv,
  signalBridge: ReturnType<typeof createAgentCliSignalBridge>,
) {
  for (const [attempt, retryDelayMs] of [
    ...GATEWAY_TRANSIENT_CONNECT_RETRY_DELAYS_MS,
    0,
  ].entries()) {
    try {
      return await agentViaGatewayCommand(opts, runtime, signalBridge);
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      const isFinalAttempt = attempt === GATEWAY_TRANSIENT_CONNECT_RETRY_DELAYS_MS.length;
      if (isFinalAttempt || !isTransientGatewayAgentConnectClose(err)) {
        throw err;
      }
      runtime.error?.(
        `Gateway agent connection closed during handshake; retrying in ${retryDelayMs}ms before failing.`,
      );
      await delayMs(retryDelayMs, signalBridge.signal);
    }
  }
  throw new Error("Gateway agent retry loop exhausted unexpectedly.");
}

export async function agentCliCommand(
  opts: AgentCliOpts,
  runtime: RuntimeEnv,
  deps?: AgentCliDeps,
) {
  protectJsonStdout(opts);
  const messageOpts = await resolveAgentMessageOpts(opts);
  // `/compact` cannot run as a plain CLI agent turn: the slash-command handler
  // rejects CLI-originated senders, so the message would fall through to a
  // normal turn and exit 0 without compacting anything (issue #90640 Gap B).
  // Fail loudly and point at the first-class command instead of no-opping.
  if (isCompactControlCommand(messageOpts.message)) {
    runtime.error?.(
      "Slash commands cannot be executed via --message from the CLI. Use: openclaw sessions compact <key>",
    );
    runtime.exit(1);
    return undefined;
  }
  const dispatchOpts = await normalizeSessionKeyOptsForDispatch(messageOpts);
  validateExplicitSessionKeyForDispatch(dispatchOpts);
  const gatewayDispatchOpts = dispatchOpts.runId
    ? dispatchOpts
    : { ...dispatchOpts, runId: randomIdempotencyKey() };
  const signalBridge = createAgentCliSignalBridge(resolveAgentCliProcessLike(deps));
  try {
    if (dispatchOpts.local === true) {
      const stateLock = await acquireEmbeddedAgentStateLock(
        deps?.localGatewayLockOptions,
        signalBridge.signal,
      );
      let result: Awaited<ReturnType<typeof runEmbeddedAgentCommand>>;
      try {
        result = await runEmbeddedAgentCommand(
          {
            ...gatewayDispatchOpts,
            agentId:
              gatewayDispatchOpts.agent ?? gatewayDispatchOpts.localGatewayCompatibilityAgentId,
            replyAccountId: gatewayDispatchOpts.replyAccount,
            cleanupBundleMcpOnRunEnd: true,
            cleanupCliLiveSessionOnRunEnd: true,
            oneShotCliRun: true,
            abortSignal: signalBridge.signal,
          },
          runtime,
          deps,
          { suppressStdoutDiagnosticLogs: dispatchOpts.json === true },
        );
      } finally {
        await stateLock?.release();
      }
      return returnAfterSignalExit(result, signalBridge.getReceivedSignal(), runtime);
    }

    try {
      const result = await agentViaGatewayCommandWithTransientRetries(
        gatewayDispatchOpts,
        runtime,
        signalBridge,
      );
      return returnAfterSignalExit(result, signalBridge.getReceivedSignal(), runtime);
    } catch (err) {
      if (isAbortError(err)) {
        if (exitForReceivedSignal(signalBridge.getReceivedSignal(), runtime)) {
          return undefined;
        }
        throw err;
      }
      const failureHint = resolveGatewayAgentFailureHint(err);
      if (failureHint) {
        // Transport loss is ambiguous: the Gateway may have accepted and may still
        // finish this turn. Recommending a blind retry or --local here could
        // double-execute the message, so point at verification first.
        runtime.error?.(
          `Gateway agent call ${failureHint}; the Gateway may still be running this turn. Check \`openclaw gateway status\` and the session transcript before retrying or rerunning with --local, so the turn does not execute twice.`,
        );
      }
      throw err;
    }
  } catch (err) {
    if (isAbortError(err) && exitForReceivedSignal(signalBridge.getReceivedSignal(), runtime)) {
      return undefined;
    }
    throw err;
  } finally {
    signalBridge.dispose();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
