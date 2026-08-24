import crypto from "node:crypto";
import {
  AgentHarnessPreflightError,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isCodexAppServerRequestTimeoutError, type CodexAppServerClient } from "./client.js";
import type { CodexPluginDestructiveApprovalMode } from "./config.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  buildPluginAppPolicyContext,
  type CodexAppPolicyContextEntry,
  type CodexPluginThreadConfig,
  type PluginAppPolicyContext,
} from "./plugin-thread-config.js";
import { isJsonObject, type v2 } from "./protocol.js";
import type { CodexAttemptConnection } from "./run-attempt-connection.js";
import { withAbortableTimeout } from "./timeout.js";

const CODEX_SCHEDULED_APP_AUTHORITY_NAMESPACE = "codex.apps";
const CODEX_APPS_MCP_SERVER = "codex_apps";
const MCP_STATUS_PAGE_SIZE = 100;
const MCP_STATUS_MAX_PAGES = 100;
const CODEX_APP_AUTHORITY_CAPTURE_TIMEOUT_MS = 60_000;
const CODEX_APP_AUTHORITY_CAPTURE_MIN_TIMEOUT_MS = 100;

type CronRuntimeAuthority = NonNullable<EmbeddedRunAttemptParams["scheduledRuntimeAuthority"]>;
type CodexAppToolApprovalMode = "auto" | "prompt" | "writes" | "approve";
export type CurrentCodexScheduledAppPolicy = {
  config: Record<string, unknown>;
  toolNamesByApp: ReadonlyMap<string, ReadonlySet<string>>;
};

export function resolveScheduledCodexAppCreatorCaptureDecision(params: {
  appsMayBeVisible: boolean;
  authenticatedScheduledMode: boolean;
  usesSupervisionConnection: boolean;
  homeScope: string | undefined;
  hasPreparedAccountIdentity: boolean;
}): { required: boolean; supported: boolean; unavailableReason?: string } {
  if (!params.appsMayBeVisible) {
    return { required: false, supported: false };
  }
  const unavailableReason = params.authenticatedScheduledMode
    ? "A scheduled Codex continuation cannot create new app-authorized automations. Recreate it from a fresh authenticated owner turn; no automation changes were saved."
    : params.usesSupervisionConnection
      ? "Codex apps are visible through a supervised connection that cannot capture creator authority. Use an isolated prepared-profile Codex creator turn; no automation changes were saved."
      : params.homeScope === "user"
        ? "Codex apps are visible through a user-home runtime that cannot capture isolated creator authority. Use an agent-scoped prepared-profile Codex creator turn; no automation changes were saved."
        : !params.hasPreparedAccountIdentity
          ? "Codex app authority requires a genuine ChatGPT account identity. Reauthenticate the selected Codex profile, then retry; no automation changes were saved."
          : undefined;
  return {
    required: true,
    supported: !unavailableReason,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

type ScheduledCodexAppAuthorityPayload = {
  version: 1;
  auth: { profileId: string; accountId: string };
  apps: Array<{
    id: string;
    allowDestructiveActions: boolean;
    allowOpenWorld: boolean;
    destructiveApprovalMode: CodexPluginDestructiveApprovalMode;
    tools: Record<string, CodexAppToolApprovalMode>;
  }>;
};

function readConnectorId(tool: unknown): string | undefined {
  const meta = asOptionalRecord(asOptionalRecord(tool)?.["_meta"]);
  return normalizeOptionalString(meta?.connector_id) ?? normalizeOptionalString(meta?.connectorId);
}

function normalizeApprovalMode(value: unknown): CodexPluginDestructiveApprovalMode | undefined {
  return value === "allow" || value === "deny" || value === "auto" || value === "ask"
    ? value
    : undefined;
}

function normalizeAppToolApprovalMode(value: unknown): CodexAppToolApprovalMode | undefined {
  return value === "auto" || value === "prompt" || value === "writes" || value === "approve"
    ? value
    : undefined;
}

function defaultApprovalMode(entry: CodexAppPolicyContextEntry) {
  return entry.destructiveApprovalMode ?? (entry.allowDestructiveActions ? "allow" : "deny");
}

function parseScheduledCodexAppAuthority(
  authority: EmbeddedRunAttemptParams["scheduledRuntimeAuthority"],
): ScheduledCodexAppAuthorityPayload | undefined {
  if (!authority || authority.runtimeId !== "codex") {
    return undefined;
  }
  if (authority.version !== 1) {
    throw new Error("Unsupported Codex scheduled authority version; reauthorize this automation.");
  }
  if (authority.namespace !== CODEX_SCHEDULED_APP_AUTHORITY_NAMESPACE) {
    throw new Error(
      `Unsupported Codex scheduled authority namespace ${authority.namespace}; reauthorize this automation.`,
    );
  }
  const payload = asOptionalRecord(authority.payload);
  const auth = asOptionalRecord(payload?.auth);
  const profileId = normalizeOptionalString(auth?.profileId);
  const accountId = normalizeOptionalString(auth?.accountId);
  if (payload?.version !== 1 || !profileId || !accountId || !Array.isArray(payload.apps)) {
    throw new Error("Stored Codex app authority is invalid; reauthorize this automation.");
  }
  const seen = new Set<string>();
  const apps = payload.apps.map((raw) => {
    const app = asOptionalRecord(raw);
    const id = normalizeOptionalString(app?.id);
    const destructiveApprovalMode = normalizeApprovalMode(app?.destructiveApprovalMode);
    const rawTools = asOptionalRecord(app?.tools);
    if (
      !id ||
      seen.has(id) ||
      typeof app?.allowDestructiveActions !== "boolean" ||
      typeof app.allowOpenWorld !== "boolean" ||
      !destructiveApprovalMode ||
      !rawTools
    ) {
      throw new Error("Stored Codex app authority is invalid; reauthorize this automation.");
    }
    seen.add(id);
    const tools: Record<string, CodexAppToolApprovalMode> = {};
    for (const [name, rawMode] of Object.entries(rawTools)) {
      const toolName = normalizeOptionalString(name);
      const mode = normalizeAppToolApprovalMode(rawMode);
      if (!toolName || !mode) {
        throw new Error("Stored Codex app authority is invalid; reauthorize this automation.");
      }
      tools[toolName] = mode;
    }
    return {
      id,
      allowDestructiveActions: app.allowDestructiveActions,
      allowOpenWorld: app.allowOpenWorld,
      destructiveApprovalMode,
      tools,
    };
  });
  return { version: 1, auth: { profileId, accountId }, apps };
}

type CodexScheduledAppPolicyRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

async function readCodexScheduledAppToolNamesByApp(params: {
  request: CodexScheduledAppPolicyRequest;
  threadId?: string;
}): Promise<Map<string, Set<string>>> {
  const toolNamesByApp = new Map<string, Set<string>>();
  const seenCursors = new Set<string>();
  let cursor: string | null | undefined;
  for (let page = 0; page < MCP_STATUS_MAX_PAGES; page += 1) {
    const response = await params.request("mcpServerStatus/list", {
      ...(params.threadId ? { threadId: params.threadId } : {}),
      detail: "toolsAndAuthOnly",
      limit: MCP_STATUS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (!isJsonObject(response) || !Array.isArray(response.data)) {
      throw new Error("Codex mcpServerStatus/list returned invalid scheduled app inventory");
    }
    for (const status of response.data) {
      if (!isJsonObject(status) || !isJsonObject(status.tools)) {
        throw new Error("Codex scheduled app inventory contained an invalid server status");
      }
      if (status.name !== CODEX_APPS_MCP_SERVER) {
        continue;
      }
      for (const [toolName, tool] of Object.entries(status.tools)) {
        const connectorId = readConnectorId(tool);
        if (connectorId) {
          const names = toolNamesByApp.get(connectorId) ?? new Set<string>();
          names.add(toolName);
          toolNamesByApp.set(connectorId, names);
        }
      }
    }
    if (
      response.nextCursor !== undefined &&
      response.nextCursor !== null &&
      typeof response.nextCursor !== "string"
    ) {
      throw new Error("Codex scheduled app inventory returned an invalid pagination cursor");
    }
    cursor = response.nextCursor;
    if (!cursor) {
      return toolNamesByApp;
    }
    if (seenCursors.has(cursor)) {
      throw new Error("Codex app connector inventory repeated its pagination cursor");
    }
    seenCursors.add(cursor);
  }
  throw new Error("Codex app connector inventory exceeded its bounded page limit");
}

/** Reads the current account policy and connector-backed tool names under one caller deadline. */
export async function readCurrentCodexScheduledAppPolicy(params: {
  request: CodexScheduledAppPolicyRequest;
  configCwd?: string;
  threadId?: string;
}): Promise<CurrentCodexScheduledAppPolicy> {
  const [configResponse, toolNamesByApp] = await Promise.all([
    params.request("config/read", {
      includeLayers: false,
      ...(params.configCwd ? { cwd: params.configCwd } : {}),
    }),
    readCodexScheduledAppToolNamesByApp(params),
  ]);
  if (!isJsonObject(configResponse)) {
    throw new Error("Codex config/read returned an invalid scheduled app policy response");
  }
  return {
    config: isJsonObject(configResponse.config) ? configResponse.config : {},
    toolNamesByApp,
  };
}

function readToolApprovalMode(
  config: Record<string, unknown>,
  appId: string,
  toolName: string,
  fallback: CodexAppToolApprovalMode = "auto",
): CodexAppToolApprovalMode {
  const app = asOptionalRecord(asOptionalRecord(config.apps)?.[appId]);
  const tool = asOptionalRecord(asOptionalRecord(app?.tools)?.[toolName]);
  return normalizeAppToolApprovalMode(tool?.approval_mode) ?? fallback;
}

/** Captures only apps callable on the exact active Codex client/thread. */
export async function captureScheduledCodexAppAuthority(params: {
  client: Pick<CodexAppServerClient, "request">;
  threadId: string;
  policyContext: PluginAppPolicyContext;
  profileId: string;
  accountId: string;
  configCwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CronRuntimeAuthority | undefined> {
  const requestedTimeoutMs = params.timeoutMs ?? CODEX_APP_AUTHORITY_CAPTURE_TIMEOUT_MS;
  const timeoutMs = Math.min(
    CODEX_APP_AUTHORITY_CAPTURE_TIMEOUT_MS,
    Math.max(
      CODEX_APP_AUTHORITY_CAPTURE_MIN_TIMEOUT_MS,
      Number.isFinite(requestedTimeoutMs)
        ? Math.floor(requestedTimeoutMs)
        : CODEX_APP_AUTHORITY_CAPTURE_TIMEOUT_MS,
    ),
  );
  const deadlineMs = Date.now() + timeoutMs;
  const boundedClient = {
    request: ((method: string, requestParams: unknown) => {
      const remainingTimeoutMs = deadlineMs - Date.now();
      if (remainingTimeoutMs <= 0) {
        throw new CodexScheduledAppAuthorityCaptureTimeoutError();
      }
      return params.client.request(method as never, requestParams as never, {
        timeoutMs: remainingTimeoutMs,
        signal: params.signal,
      });
    }) as CodexAppServerClient["request"],
  };
  let installed: v2.AppsInstalledResponse;
  let currentPolicy: CurrentCodexScheduledAppPolicy;
  try {
    [installed, currentPolicy] = await withAbortableTimeout({
      promise: Promise.all([
        boundedClient.request("app/installed", {
          threadId: params.threadId,
          forceRefresh: false,
        }),
        readCurrentCodexScheduledAppPolicy({
          request: (method, requestParams) =>
            boundedClient.request(method as never, requestParams as never),
          threadId: params.threadId,
          configCwd: params.configCwd,
        }),
      ]),
      timeoutMs,
      signal: params.signal,
      timeoutMessage: "Codex scheduled app authority capture deadline elapsed",
      createTimeoutError: () => new CodexScheduledAppAuthorityCaptureTimeoutError(),
    });
  } catch (error) {
    if (
      params.signal?.aborted ||
      (!(error instanceof CodexScheduledAppAuthorityCaptureTimeoutError) &&
        !isCodexAppServerRequestTimeoutError(error))
    ) {
      throw error;
    }
    throw new Error(
      `Codex app authority capture exceeded its ${timeoutMs} ms total budget. No automation changes were saved; retry after Codex app inventory is responsive.`,
      { cause: error },
    );
  }
  const callableIds = new Set(
    installed.apps.filter((app) => app.enabled && app.callable).map((app) => app.id),
  );
  const apps = Object.entries(params.policyContext.apps)
    .filter(([id]) => callableIds.has(id) && currentPolicy.toolNamesByApp.has(id))
    .map(([id, policy]) => ({
      id,
      allowDestructiveActions: policy.allowDestructiveActions,
      allowOpenWorld: policy.allowOpenWorld !== false,
      destructiveApprovalMode: defaultApprovalMode(policy),
      tools: Object.fromEntries(
        [...(currentPolicy.toolNamesByApp.get(id) ?? [])]
          .toSorted()
          .map((toolName) => [
            toolName,
            readToolApprovalMode(
              currentPolicy.config,
              id,
              toolName,
              appApprovalCeiling(defaultApprovalMode(policy)),
            ),
          ]),
      ),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  if (apps.length === 0) {
    return undefined;
  }
  return {
    version: 1,
    runtimeId: "codex",
    namespace: CODEX_SCHEDULED_APP_AUTHORITY_NAMESPACE,
    payload: {
      version: 1,
      auth: { profileId: params.profileId, accountId: params.accountId },
      apps,
    },
  };
}

class CodexScheduledAppAuthorityCaptureTimeoutError extends Error {
  constructor() {
    super("Codex scheduled app authority capture deadline elapsed");
    this.name = "CodexScheduledAppAuthorityCaptureTimeoutError";
  }
}

const APPROVAL_RANK: Record<CodexPluginDestructiveApprovalMode, number> = {
  deny: 0,
  ask: 1,
  auto: 2,
  allow: 3,
};

function stricterApprovalMode(
  left: CodexPluginDestructiveApprovalMode,
  right: CodexPluginDestructiveApprovalMode,
): CodexPluginDestructiveApprovalMode {
  return APPROVAL_RANK[left] <= APPROVAL_RANK[right] ? left : right;
}

function intersectToolApprovalMode(
  captured: CodexAppToolApprovalMode,
  current: CodexAppToolApprovalMode,
): CodexAppToolApprovalMode {
  if (captured === current) {
    return captured;
  }
  if (captured === "prompt" || current === "prompt") {
    return "prompt";
  }
  if (captured === "approve") {
    return current;
  }
  if (current === "approve") {
    return captured;
  }
  // `auto` and `writes` are annotation-dependent and not totally ordered.
  return "prompt";
}

function appApprovalCeiling(mode: CodexPluginDestructiveApprovalMode): CodexAppToolApprovalMode {
  if (mode === "allow") {
    return "approve";
  }
  return mode === "ask" ? "prompt" : "auto";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Intersects a stored app-ID cap with current policy without admitting new apps. */
export function intersectCodexPluginThreadConfigWithScheduledAuthority(
  config: CodexPluginThreadConfig,
  authority: EmbeddedRunAttemptParams["scheduledRuntimeAuthority"],
  currentPolicy: CurrentCodexScheduledAppPolicy = {
    config: {},
    toolNamesByApp: new Map(),
  },
): CodexPluginThreadConfig {
  const scheduled = parseScheduledCodexAppAuthority(authority);
  if (!scheduled) {
    return config;
  }
  const omittedAppIds = scheduled.apps
    .map((app) => app.id)
    .filter((id) => {
      const currentTools = currentPolicy.toolNamesByApp.get(id);
      return (
        !Object.hasOwn(config.policyContext.apps, id) || !currentTools || currentTools.size === 0
      );
    })
    .toSorted();
  if (omittedAppIds.length > 0) {
    const visibleIds = omittedAppIds.slice(0, 10).join(", ");
    const remaining = omittedAppIds.length - Math.min(omittedAppIds.length, 10);
    throw new AgentHarnessPreflightError(
      `Scheduled Codex apps are unavailable under the current policy or account: ${visibleIds}${remaining > 0 ? ` (and ${remaining} more)` : ""}. Restore access or reauthorize the automation from a fresh authenticated Codex owner turn.`,
    );
  }
  const capturedById = new Map(scheduled.apps.map((app) => [app.id, app] as const));
  const apps: Record<string, CodexAppPolicyContextEntry> = {};
  for (const [id, current] of Object.entries(config.policyContext.apps)) {
    const captured = capturedById.get(id);
    if (!captured) {
      continue;
    }
    apps[id] = {
      ...current,
      allowDestructiveActions: current.allowDestructiveActions && captured.allowDestructiveActions,
      allowOpenWorld: current.allowOpenWorld !== false && captured.allowOpenWorld,
      destructiveApprovalMode: stricterApprovalMode(
        defaultApprovalMode(current),
        captured.destructiveApprovalMode,
      ),
    };
  }
  const pluginAppIds = Object.fromEntries(
    Object.entries(config.policyContext.pluginAppIds)
      .map(([key, ids]) => [key, ids.filter((id) => Object.hasOwn(apps, id))] as const)
      .filter(([, ids]) => ids.length > 0),
  );
  const policyContext = buildPluginAppPolicyContext(apps, pluginAppIds);
  const configPatch = buildCodexPluginAppsConfigPatchFromPolicyContext(policyContext);
  const appsPatch = asOptionalRecord(configPatch.apps);
  for (const [appId, captured] of capturedById) {
    const appPatch = asOptionalRecord(appsPatch?.[appId]);
    if (!appPatch || !Object.hasOwn(apps, appId)) {
      continue;
    }
    const currentApp = apps[appId];
    if (!currentApp) {
      continue;
    }
    const storedAppCeiling = appApprovalCeiling(captured.destructiveApprovalMode);
    const currentAppCeiling = appApprovalCeiling(defaultApprovalMode(currentApp));
    // Current inventory owns existence; captured modes only cap tools that
    // still exist (and tools added later within the already-authorized app).
    const toolNames = currentPolicy.toolNamesByApp.get(appId) ?? new Set<string>();
    appPatch.tools = Object.fromEntries(
      [...toolNames].toSorted().map((toolName) => {
        const capturedMode = captured.tools[toolName] ?? storedAppCeiling;
        return [
          toolName,
          {
            approval_mode: intersectToolApprovalMode(
              intersectToolApprovalMode(capturedMode, storedAppCeiling),
              intersectToolApprovalMode(
                readToolApprovalMode(currentPolicy.config, appId, toolName, currentAppCeiling),
                currentAppCeiling,
              ),
            ),
          },
        ];
      }),
    );
  }
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      stableStringify({
        version: 1,
        namespace: CODEX_SCHEDULED_APP_AUTHORITY_NAMESPACE,
        authority: scheduled,
        inputFingerprint: config.inputFingerprint,
        policyContext,
        configPatch,
      }),
    )
    .digest("hex");
  return {
    ...config,
    fingerprint,
    configPatch,
    provisionalAppIds: Object.keys(apps).toSorted(),
    policyContext,
  };
}

function readScheduledCodexAppAuthorityAuth(
  authority: EmbeddedRunAttemptParams["scheduledRuntimeAuthority"],
): ScheduledCodexAppAuthorityPayload["auth"] | undefined {
  return parseScheduledCodexAppAuthority(authority)?.auth;
}

export function assertScheduledCodexAppAuthorityRuntime(
  connection: Pick<
    CodexAttemptConnection,
    "usesSupervisionConnection" | "appServer" | "startupPreparedAuth"
  >,
  params: Pick<EmbeddedRunAttemptParams, "trigger" | "scheduledRuntimeAuthority">,
): void {
  const scheduledAuth = readScheduledCodexAppAuthorityAuth(params.scheduledRuntimeAuthority);
  if (!scheduledAuth) {
    return;
  }
  if (
    params.trigger !== "cron" ||
    connection.usesSupervisionConnection ||
    connection.appServer.start.homeScope === "user"
  ) {
    throw new AgentHarnessPreflightError(
      "This automation's Codex app authority requires an isolated scheduled prepared-profile runtime. Reauthorize it from a supported Codex creator turn.",
    );
  }
  const prepared = connection.startupPreparedAuth;
  if (
    prepared?.kind !== "profile" ||
    prepared.profileId !== scheduledAuth.profileId ||
    prepared.snapshot?.loginParams.type !== "chatgptAuthTokens" ||
    prepared.snapshot.chatgptAccountId !== scheduledAuth.accountId
  ) {
    throw new AgentHarnessPreflightError(
      `This automation was authorized for Codex profile ${scheduledAuth.profileId}, but that exact prepared account is not active. Restore the profile or reauthorize the automation from a fresh owner turn.`,
    );
  }
}

export function buildLegacyScheduledCodexAppRecoveryPrompt(
  params: Pick<
    EmbeddedRunAttemptParams,
    "trigger" | "scheduledRuntimeAuthority" | "scheduledRuntimeAuthorityRecoveryRequired"
  >,
): string | undefined {
  if (
    params.trigger !== "cron" ||
    !params.scheduledRuntimeAuthorityRecoveryRequired ||
    params.scheduledRuntimeAuthority
  ) {
    return undefined;
  }
  return "Scheduled Codex app access is unavailable because this automation predates runtime-specific app authority capture. Tell the operator to recreate or reauthorize it from a fresh authenticated Codex owner turn; do not claim an app action succeeded.";
}

/** Makes stored-cap identity part of thread reuse admission, including cap removal. */
export function buildScheduledCodexAppAuthorityInputFingerprint(
  baseFingerprint: string,
  authority: EmbeddedRunAttemptParams["scheduledRuntimeAuthority"],
): string {
  const scheduled = parseScheduledCodexAppAuthority(authority);
  if (!scheduled) {
    return baseFingerprint;
  }
  return crypto
    .createHash("sha256")
    .update(
      stableStringify({
        version: 1,
        namespace: CODEX_SCHEDULED_APP_AUTHORITY_NAMESPACE,
        baseFingerprint,
        authority: scheduled,
      }),
    )
    .digest("hex");
}
