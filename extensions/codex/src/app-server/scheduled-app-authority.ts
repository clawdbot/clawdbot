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
import { readCodexMcpToolConnectorId } from "./mcp-tool-metadata.js";
import { buildCodexAppApprovalOverrides } from "./plugin-app-approval-overrides.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  buildPluginAppPolicyContext,
  disableUnlistedCodexApps,
  stringifyCodexPluginPolicy,
  type CodexAppPolicyContextEntry,
  type CodexPluginThreadConfig,
  type PluginAppPolicyContext,
} from "./plugin-thread-config.js";
import { isJsonObject, type v2 } from "./protocol.js";
import type { CodexAttemptConnection } from "./run-attempt-connection.js";
import { readCodexManagedRequirementsFingerprint } from "./thread-requests.js";
import { withAbortableTimeout } from "./timeout.js";

const CODEX_SCHEDULED_APP_AUTHORITY_NAMESPACE = "codex.apps";
const CODEX_APPS_MCP_SERVER = "codex_apps";
const MCP_STATUS_PAGE_SIZE = 100;
const MCP_STATUS_MAX_PAGES = 100;
const CODEX_APP_AUTHORITY_CAPTURE_TIMEOUT_MS = 60_000;
const CODEX_APP_AUTHORITY_CAPTURE_MIN_TIMEOUT_MS = 100;

type CronRuntimeAuthority = NonNullable<EmbeddedRunAttemptParams["scheduledRuntimeAuthority"]>;
type CodexAppToolApprovalMode = "auto" | "prompt" | "writes" | "approve";
type CodexScheduledAppTool = {
  title?: string;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};
export type CurrentCodexScheduledAppPolicy = {
  config: Record<string, unknown>;
  toolsByApp: ReadonlyMap<string, ReadonlyMap<string, CodexScheduledAppTool>>;
};

export type ScheduledCodexAppCreatorAuth =
  | { kind: "prepared-profile"; profileId: string; accountId: string }
  | { kind: "configured-app-server"; connectionFingerprint: string };

/** Hashes stable configured endpoint identity without retaining credentials or endpoint details. */
export function buildScheduledCodexAppServerConnectionIdentity(
  appServer: Pick<
    CodexAttemptConnection["appServer"],
    "start" | "connectionClass" | "remoteWorkspaceRoot"
  >,
): string {
  const start = appServer.start;
  return crypto
    .createHash("sha256")
    .update("openclaw:codex:scheduled-app-server:v1\0")
    .update(
      JSON.stringify({
        transport: start.transport,
        command: start.command,
        commandSource: start.commandSource ?? null,
        args: start.args,
        cwd: start.cwd ?? null,
        url: start.url ?? null,
        homeScope: start.homeScope ?? null,
        connectionClass: appServer.connectionClass,
        remoteWorkspaceRoot: appServer.remoteWorkspaceRoot ?? null,
      }),
    )
    .digest("hex");
}

export function resolveScheduledCodexAppCreatorCaptureDecision(params: {
  appsMayBeVisible: boolean;
  authenticatedScheduledMode: boolean;
  usesSupervisionConnection: boolean;
  homeScope: string | undefined;
  hasPreparedAccountIdentity: boolean;
  hasConfiguredAppServerIdentity: boolean;
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
        : !params.hasPreparedAccountIdentity && !params.hasConfiguredAppServerIdentity
          ? "Codex app authority requires either a prepared ChatGPT profile or an isolated configured app-server identity. Reauthenticate the selected Codex profile or configured app-server, then retry; no automation changes were saved."
          : undefined;
  return {
    required: true,
    supported: !unavailableReason,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

type ScheduledCodexAppPreparedProfileAuth = {
  kind?: undefined;
  profileId: string;
  accountId: string;
};
type ScheduledCodexAppConfiguredServerAuth = {
  kind: "configured-app-server";
  connectionFingerprint: string;
  managedRequirementsFingerprint: string;
};
type ScheduledCodexAppAuthorityAuth =
  | ScheduledCodexAppPreparedProfileAuth
  | ScheduledCodexAppConfiguredServerAuth;

type ScheduledCodexAppAuthorityPayload = {
  version: 1;
  auth: ScheduledCodexAppAuthorityAuth;
  apps: Array<{
    id: string;
    allowDestructiveActions: boolean;
    allowOpenWorld: boolean;
    destructiveApprovalMode: CodexPluginDestructiveApprovalMode;
    tools: Record<string, CodexAppToolApprovalMode>;
  }>;
};

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
  const connectionFingerprint = normalizeOptionalString(auth?.connectionFingerprint);
  const managedRequirementsFingerprint = normalizeOptionalString(
    auth?.managedRequirementsFingerprint,
  );
  const accountId = normalizeOptionalString(auth?.accountId);
  const parsedAuth: ScheduledCodexAppAuthorityAuth | undefined =
    auth?.kind === "configured-app-server" &&
    connectionFingerprint &&
    managedRequirementsFingerprint
      ? {
          kind: "configured-app-server",
          connectionFingerprint,
          managedRequirementsFingerprint,
        }
      : auth?.kind === undefined && profileId && accountId
        ? { profileId, accountId }
        : undefined;
  if (payload?.version !== 1 || !parsedAuth || !Array.isArray(payload.apps)) {
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
  return { version: 1, auth: parsedAuth, apps };
}

type CodexScheduledAppPolicyRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

async function readCodexScheduledAppToolsByApp(params: {
  request: CodexScheduledAppPolicyRequest;
  threadId?: string;
}): Promise<Map<string, Map<string, CodexScheduledAppTool>>> {
  const toolsByApp = new Map<string, Map<string, CodexScheduledAppTool>>();
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
        const connectorId = readCodexMcpToolConnectorId(tool);
        if (connectorId) {
          const tools = toolsByApp.get(connectorId) ?? new Map<string, CodexScheduledAppTool>();
          const metadata = asOptionalRecord(tool);
          const annotations = asOptionalRecord(metadata?.annotations);
          tools.set(toolName, {
            title: typeof metadata?.title === "string" ? metadata.title : undefined,
            destructiveHint: annotations?.destructiveHint === false ? false : undefined,
            openWorldHint: annotations?.openWorldHint === false ? false : undefined,
          });
          toolsByApp.set(connectorId, tools);
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
      return toolsByApp;
    }
    if (seenCursors.has(cursor)) {
      throw new Error("Codex app connector inventory repeated its pagination cursor");
    }
    seenCursors.add(cursor);
  }
  throw new Error("Codex app connector inventory exceeded its bounded page limit");
}

/** Reads current account policy and connector-backed tool metadata under one caller deadline. */
export async function readCurrentCodexScheduledAppPolicy(params: {
  request: CodexScheduledAppPolicyRequest;
  configCwd?: string;
  threadId?: string;
}): Promise<CurrentCodexScheduledAppPolicy> {
  const [configResponse, toolsByApp] = await Promise.all([
    params.request("config/read", {
      includeLayers: false,
      ...(params.configCwd ? { cwd: params.configCwd } : {}),
    }),
    readCodexScheduledAppToolsByApp(params),
  ]);
  if (!isJsonObject(configResponse)) {
    throw new Error("Codex config/read returned an invalid scheduled app policy response");
  }
  return {
    config: isJsonObject(configResponse.config) ? configResponse.config : {},
    toolsByApp,
  };
}

function readCurrentToolPolicy(
  config: Record<string, unknown>,
  appId: string,
  toolName: string,
  metadata: CodexScheduledAppTool | undefined,
  fallbackApprovalMode: CodexAppToolApprovalMode = "auto",
): { enabled: boolean; approvalMode: CodexAppToolApprovalMode } {
  const apps = asOptionalRecord(config.apps);
  const app = asOptionalRecord(apps?.[appId]);
  const defaults = asOptionalRecord(apps?.["_default"]);
  const tools = asOptionalRecord(app?.tools);
  // Codex selects the full-name entry before the title entry, not each field
  // independently. Preserve that precedence for both enablement and approval.
  const tool = asOptionalRecord(
    tools?.[toolName] ?? (metadata?.title !== undefined ? tools?.[metadata.title] : undefined),
  );
  const defaultToolsEnabled = app?.default_tools_enabled;
  return {
    enabled:
      (app ? app.enabled !== false : defaults?.enabled !== false) &&
      (typeof tool?.enabled === "boolean"
        ? tool.enabled
        : typeof defaultToolsEnabled === "boolean"
          ? defaultToolsEnabled
          : appToolHintsAllowed(metadata, {
              allowDestructiveActions:
                (app?.destructive_enabled ?? defaults?.destructive_enabled) !== false,
              allowOpenWorld: (app?.open_world_enabled ?? defaults?.open_world_enabled) !== false,
            })),
    approvalMode:
      normalizeAppToolApprovalMode(tool?.approval_mode) ??
      normalizeAppToolApprovalMode(app?.default_tools_approval_mode) ??
      normalizeAppToolApprovalMode(defaults?.default_tools_approval_mode) ??
      fallbackApprovalMode,
  };
}

function appToolHintsAllowed(
  tool: CodexScheduledAppTool | undefined,
  policy: Pick<CodexAppPolicyContextEntry, "allowDestructiveActions" | "allowOpenWorld">,
): boolean {
  // Codex treats missing annotations as destructive/open-world. Explicit tool
  // enablement bypasses its app flags, so enforce the stored cap before projecting it.
  return (
    (policy.allowDestructiveActions || tool?.destructiveHint === false) &&
    (policy.allowOpenWorld !== false || tool?.openWorldHint === false)
  );
}

/** Captures only apps callable on the exact active Codex client/thread. */
export async function captureScheduledCodexAppAuthority(params: {
  client: Pick<CodexAppServerClient, "request">;
  threadId: string;
  policyContext: PluginAppPolicyContext;
  auth: ScheduledCodexAppCreatorAuth;
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
  let auth: ScheduledCodexAppAuthorityAuth;
  const creatorAuth = params.auth;
  try {
    [installed, currentPolicy, auth] = await withAbortableTimeout({
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
        creatorAuth.kind === "prepared-profile"
          ? Promise.resolve({ profileId: creatorAuth.profileId, accountId: creatorAuth.accountId })
          : readCodexManagedRequirementsFingerprint(boundedClient, params.signal).then(
              (managedRequirementsFingerprint) => ({
                kind: creatorAuth.kind,
                connectionFingerprint: creatorAuth.connectionFingerprint,
                managedRequirementsFingerprint,
              }),
            ),
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
    .filter(([id]) => callableIds.has(id) && currentPolicy.toolsByApp.has(id))
    .map(([id, policy]) => ({
      id,
      allowDestructiveActions: policy.allowDestructiveActions,
      allowOpenWorld: policy.allowOpenWorld !== false,
      destructiveApprovalMode: defaultApprovalMode(policy),
      tools: Object.fromEntries(
        [...(currentPolicy.toolsByApp.get(id)?.keys() ?? [])]
          .toSorted()
          .map((toolName) => [
            toolName,
            readCurrentToolPolicy(
              currentPolicy.config,
              id,
              toolName,
              currentPolicy.toolsByApp.get(id)?.get(toolName),
              appApprovalCeiling(defaultApprovalMode(policy)),
            ).approvalMode,
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
      auth,
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

/** Intersects a stored app-ID cap with current policy without admitting new apps. */
export function intersectCodexPluginThreadConfigWithScheduledAuthority(
  config: CodexPluginThreadConfig,
  authority: EmbeddedRunAttemptParams["scheduledRuntimeAuthority"],
  currentPolicy: CurrentCodexScheduledAppPolicy = {
    config: {},
    toolsByApp: new Map(),
  },
): CodexPluginThreadConfig {
  const scheduled = parseScheduledCodexAppAuthority(authority);
  if (!scheduled) {
    return config;
  }
  const omittedAppIds = scheduled.apps
    .map((app) => app.id)
    .filter((id) => {
      const currentTools = currentPolicy.toolsByApp.get(id);
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
  const configPatch = disableUnlistedCodexApps(
    buildCodexPluginAppsConfigPatchFromPolicyContext(policyContext),
    currentPolicy.config,
  );
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
    if (currentApp.destructiveApprovalMode === "ask") {
      // Captured ask can tighten today's policy. Pin the link reviewer too;
      // per-tool prompt ceilings below do not override native account reviewers.
      Object.assign(
        appPatch,
        buildCodexAppApprovalOverrides(currentPolicy.config, {
          id: appId,
          approvalOverrideToolConfigKeys: [],
        }),
      );
    }
    const storedAppCeiling = appApprovalCeiling(captured.destructiveApprovalMode);
    const currentAppCeiling = appApprovalCeiling(defaultApprovalMode(currentApp));
    // Current inventory owns existence; captured modes only cap tools that
    // still exist (and tools added later within the already-authorized app).
    const tools = currentPolicy.toolsByApp.get(appId) ?? new Map<string, CodexScheduledAppTool>();
    appPatch.tools = Object.fromEntries(
      [...tools.keys()].toSorted().map((toolName) => {
        const capturedMode = captured.tools[toolName] ?? storedAppCeiling;
        const currentToolPolicy = readCurrentToolPolicy(
          currentPolicy.config,
          appId,
          toolName,
          tools.get(toolName),
          currentAppCeiling,
        );
        return [
          toolName,
          {
            enabled:
              currentToolPolicy.enabled && appToolHintsAllowed(tools.get(toolName), currentApp),
            approval_mode: intersectToolApprovalMode(
              intersectToolApprovalMode(capturedMode, storedAppCeiling),
              intersectToolApprovalMode(currentToolPolicy.approvalMode, currentAppCeiling),
            ),
          },
        ];
      }),
    );
  }
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      stringifyCodexPluginPolicy({
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

/** Returns the managed-requirements identity captured for a configured app-server job. */
export function readScheduledCodexAppManagedRequirementsFingerprint(
  authority: EmbeddedRunAttemptParams["scheduledRuntimeAuthority"],
): string | undefined {
  const auth = parseScheduledCodexAppAuthority(authority)?.auth;
  return auth?.kind === "configured-app-server" ? auth.managedRequirementsFingerprint : undefined;
}

export function assertScheduledCodexAppAuthorityRuntime(
  connection: Pick<
    CodexAttemptConnection,
    "usesSupervisionConnection" | "appServer" | "startupPreparedAuth"
  >,
  params: Pick<EmbeddedRunAttemptParams, "trigger" | "scheduledRuntimeAuthority">,
): void {
  const scheduledAuth = parseScheduledCodexAppAuthority(params.scheduledRuntimeAuthority)?.auth;
  if (!scheduledAuth) {
    return;
  }
  if (
    params.trigger !== "cron" ||
    connection.usesSupervisionConnection ||
    connection.appServer.start.homeScope === "user"
  ) {
    throw new AgentHarnessPreflightError(
      "This automation's Codex app authority requires an isolated scheduled runtime. Reauthorize it from a supported Codex creator turn.",
    );
  }
  if (scheduledAuth.kind === "configured-app-server") {
    // Configured jobs belong to the endpoint, not its current ChatGPT account.
    // Removal or fingerprint rotation rejects before prewarm; cron records the failure.
    const connectionFingerprint = buildScheduledCodexAppServerConnectionIdentity(
      connection.appServer,
    );
    if (connectionFingerprint !== scheduledAuth.connectionFingerprint) {
      throw new AgentHarnessPreflightError(
        "This automation was authorized for a different configured Codex app-server. Restore that connection or reauthorize the automation from a fresh owner turn.",
      );
    }
    return;
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
      stringifyCodexPluginPolicy({
        version: 1,
        namespace: CODEX_SCHEDULED_APP_AUTHORITY_NAMESPACE,
        baseFingerprint,
        authority: scheduled,
      }),
    )
    .digest("hex");
}
