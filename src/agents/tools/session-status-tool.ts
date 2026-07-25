/**
 * session_status built-in tool.
 *
 * Reports and updates session runtime state, model overrides, visibility, task status, and delivery context.
 */
import { randomUUID } from "node:crypto";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "../../auto-reply/thinking.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  patchSessionEntryWithKey,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import {
  isPluginMetadataSnapshotCompatible,
  resolvePluginMetadataSnapshot,
} from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import {
  getSessionStateVersion,
  listSessionStateEventsSince,
} from "../../sessions/session-state-events.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { BuildStatusTextParams } from "../../status/status-text.types.js";
import { buildTaskStatusSnapshotForRelatedSessionKeyForOwner } from "../../tasks/task-owner-access.js";
import { formatTaskStatusDetail, formatTaskStatusTitle } from "../../tasks/task-status.js";
import {
  deliveryContextFromSession,
  normalizeDeliveryContext,
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { resolveDefaultAgentId } from "../agent-scope-config.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agent-scope.js";
import {
  buildModelAliasIndex,
  modelKey,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  resolveThinkingDefaultWithRuntimeCatalog,
} from "../model-selection.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import { loadPreparedModelCatalog } from "../prepared-model-catalog.js";
import { resolveSessionModelIdentityRef } from "../session-model-ref.js";
import {
  describeSessionStatusTool,
  SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  normalizeToolModelOverride,
  readNonNegativeIntegerParam,
  readStringParam,
} from "./common.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";
import {
  listImplicitDefaultDirectFallbackKeys,
  resolveImplicitCurrentSessionFallback,
  resolveSessionStatusEntry,
  resolveStoreScopedRequesterKey,
} from "./session-status-session-resolve.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveCurrentSessionClientAlias,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionReference,
  resolveVisibleSessionReference,
  shouldResolveSessionIdInput,
} from "./sessions-helpers.js";

const SessionStatusToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  changesSince: Type.Optional(Type.Integer({ minimum: 0 })),
});

const SessionStatusOriginSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: false },
);

const SessionStatusDeliveryContextSchema = Type.Object(
  {
    channel: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: false },
);

const SessionStatusStateEventPayloadSchema = Type.Object(
  {
    outcome: Type.Optional(
      Type.Union([Type.Literal("error"), Type.Literal("timeout"), Type.Literal("cancelled")]),
    ),
    channel: Type.Optional(Type.String()),
    turns: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const SessionStatusStateEventSchema = Type.Object(
  {
    sequence: Type.Integer(),
    kind: Type.String(),
    actorType: Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("system")]),
    occurredAt: Type.Number(),
    summary: Type.String(),
    actorId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    payload: Type.Optional(SessionStatusStateEventPayloadSchema),
  },
  { additionalProperties: false },
);

const SessionStatusOutputSchema = Type.Object(
  {
    ok: Type.Literal(true),
    sessionKey: Type.String(),
    changedModel: Type.Boolean(),
    stateVersion: Type.Integer(),
    statusText: Type.String(),
    stateChanges: Type.Optional(
      Type.Object(
        {
          events: Type.Array(SessionStatusStateEventSchema),
          truncated: Type.Boolean(),
          earliestAvailableSequence: Type.Integer(),
          historyGap: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    model: Type.Optional(Type.String()),
    modelProvider: Type.Optional(Type.String()),
    modelOverride: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    origin: Type.Optional(SessionStatusOriginSchema),
    active: Type.Optional(SessionStatusDeliveryContextSchema),
    deliveryContext: Type.Optional(SessionStatusDeliveryContextSchema),
  },
  { additionalProperties: false },
);

type SessionStatusStateChanges = ReturnType<typeof listSessionStateEventsSince>;

function compactSessionStateEventPayload(
  payload: Record<string, unknown> | undefined,
): { outcome?: "error" | "timeout" | "cancelled"; channel?: string; turns?: number } | undefined {
  if (!payload) {
    return undefined;
  }
  const outcome =
    payload.outcome === "error" || payload.outcome === "timeout" || payload.outcome === "cancelled"
      ? payload.outcome
      : undefined;
  const channel = readStringValue(payload.channel);
  const turns =
    typeof payload.turns === "number" && Number.isSafeInteger(payload.turns) && payload.turns > 0
      ? payload.turns
      : undefined;
  return outcome || channel || turns !== undefined
    ? {
        ...(outcome ? { outcome } : {}),
        ...(channel ? { channel } : {}),
        ...(turns !== undefined ? { turns } : {}),
      }
    : undefined;
}

function compactSessionStateChanges(stateChanges: SessionStatusStateChanges) {
  return {
    ...stateChanges,
    events: stateChanges.events.map((event) => {
      const payload = compactSessionStateEventPayload(event.payload);
      return {
        sequence: event.sequence,
        kind: event.kind,
        actorType: event.actorType,
        occurredAt: event.occurredAt,
        summary: event.summary,
        ...(event.actorId ? { actorId: event.actorId } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
        ...(payload ? { payload } : {}),
      };
    }),
  };
}

type CommandsStatusRuntimeModule = {
  buildStatusText: (params: BuildStatusTextParams) => Promise<string>;
};

const commandsStatusRuntimeLoader = createLazyImportLoader<CommandsStatusRuntimeModule>(
  () => import("./session-status.runtime.js") as Promise<CommandsStatusRuntimeModule>,
);

function loadCommandsStatusRuntime(): Promise<CommandsStatusRuntimeModule> {
  return commandsStatusRuntimeLoader.load();
}

type ActiveStatusModelIdentity = { provider?: string; model: string };

type SessionStatusOriginDetails = {
  provider?: string;
  accountId?: string;
  threadId?: string | number;
};

type SessionStatusDeliveryContextDetails = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

type SessionStatusRouteDetails = {
  origin?: SessionStatusOriginDetails;
  active?: SessionStatusDeliveryContextDetails;
  deliveryContext?: SessionStatusDeliveryContextDetails;
};

const INTERNAL_SESSION_KEY_ORIGIN_PREFIXES = new Set(["main", "cron", "subagent", "acp"]);

function readRouteThreadId(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function compactOriginDetails(params: {
  provider?: string;
  accountId?: string;
  threadId?: string | number;
}): SessionStatusOriginDetails | undefined {
  const threadId = readRouteThreadId(params.threadId);
  const details: SessionStatusOriginDetails = {
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  };
  return Object.keys(details).length ? details : undefined;
}

function compactDeliveryContextDetails(params: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}): SessionStatusDeliveryContextDetails | undefined {
  const threadId = readRouteThreadId(params.threadId);
  const details: SessionStatusDeliveryContextDetails = {
    ...(params.channel ? { channel: params.channel } : {}),
    ...(params.to ? { to: params.to } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  };
  return Object.keys(details).length ? details : undefined;
}

function normalizeStatusDeliveryContext(
  context?: DeliveryContext,
): SessionStatusDeliveryContextDetails | undefined {
  return compactDeliveryContextDetails({
    channel: readStringValue(context?.channel),
    to: readStringValue(context?.to),
    accountId: readStringValue(context?.accountId),
    threadId: context?.threadId,
  });
}

function normalizeActiveDeliveryContext(
  context?: DeliveryContext,
): SessionStatusDeliveryContextDetails | undefined {
  if (!context) {
    return undefined;
  }
  const normalized = normalizeDeliveryContext(context);
  const rawChannel = readStringValue(normalized?.channel) ?? readStringValue(context.channel);
  const channel = rawChannel ? (normalizeMessageChannel(rawChannel) ?? rawChannel) : undefined;
  return compactDeliveryContextDetails({
    channel,
    to: readStringValue(normalized?.to) ?? readStringValue(context.to),
    accountId: readStringValue(normalized?.accountId) ?? readStringValue(context.accountId),
    threadId: normalized?.threadId ?? context.threadId,
  });
}

function inferOriginProviderFromSessionKey(sessionKey: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  const head = readStringValue(parsed?.rest.split(":")[0]);
  if (!head || INTERNAL_SESSION_KEY_ORIGIN_PREFIXES.has(head.toLowerCase())) {
    return undefined;
  }
  const channel = normalizeMessageChannel(head);
  return channel && isDeliverableMessageChannel(channel) ? channel : undefined;
}

function buildSessionStatusRouteDetails(params: {
  entry: SessionEntry;
  sessionKey: string;
  activeDeliveryContext?: DeliveryContext;
  isLiveRunSession?: boolean;
}): SessionStatusRouteDetails {
  const origin = compactOriginDetails({
    provider:
      readStringValue(sessionDeliveryOrigin(params.entry)?.provider) ??
      inferOriginProviderFromSessionKey(params.sessionKey),
    accountId: readStringValue(sessionDeliveryOrigin(params.entry)?.accountId),
    threadId: sessionDeliveryOrigin(params.entry)?.threadId,
  });
  const deliveryContext = normalizeStatusDeliveryContext(deliveryContextFromSession(params.entry));
  const active = params.isLiveRunSession
    ? normalizeActiveDeliveryContext(params.activeDeliveryContext)
    : undefined;

  return {
    ...(origin ? { origin } : {}),
    ...(active ? { active } : {}),
    ...(deliveryContext ? { deliveryContext } : {}),
  };
}

function formatSessionStatusRouteContext(details: SessionStatusRouteDetails): string | undefined {
  if (Object.keys(details).length === 0) {
    return undefined;
  }
  return `Route context:
\`\`\`json
${JSON.stringify(details, null, 2)}
\`\`\``;
}

function formatSessionStateChanges(details: {
  stateVersion: number;
  stateChanges: ReturnType<typeof listSessionStateEventsSince>;
}): string {
  return `Session state changes:
\`\`\`json
${JSON.stringify(details, null, 2)}
\`\`\``;
}

function resolveActiveStatusModelIdentity(params: {
  activeModelId?: string;
  activeModelProvider?: string;
  isImplicitCurrentRequest: boolean;
  isSemanticCurrentRequest: boolean;
  liveSessionKeys: Iterable<string | undefined>;
  modelRaw?: string;
  resolvedKey: string;
}): ActiveStatusModelIdentity | undefined {
  const activeModelId = params.activeModelId?.trim();
  if (!activeModelId || params.modelRaw !== undefined) {
    return undefined;
  }
  if (!params.isSemanticCurrentRequest && !params.isImplicitCurrentRequest) {
    return undefined;
  }
  const resolvedKey = params.resolvedKey.trim();
  const liveSessionKeys = new Set(
    Array.from(params.liveSessionKeys, (value) => value?.trim()).filter((value): value is string =>
      Boolean(value),
    ),
  );
  if (!liveSessionKeys.has(resolvedKey)) {
    return undefined;
  }
  const activeModelProvider = params.activeModelProvider?.trim();
  return activeModelProvider
    ? { provider: activeModelProvider, model: activeModelId }
    : { model: activeModelId };
}

function withActiveStatusModelIdentity(
  entry: SessionEntry,
  identity: ActiveStatusModelIdentity,
): SessionEntry {
  const next: SessionEntry = {
    ...entry,
    model: identity.model,
    ...(identity.provider ? { modelProvider: identity.provider } : {}),
  };
  delete next.providerOverride;
  delete next.modelOverride;
  delete next.modelOverrideSource;
  return next;
}

function formatSessionTaskLine(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
}): string | undefined {
  const snapshot = buildTaskStatusSnapshotForRelatedSessionKeyForOwner({
    relatedSessionKey: params.relatedSessionKey,
    callerOwnerKey: params.callerOwnerKey,
  });
  const task = snapshot.focus;
  if (!task) {
    return undefined;
  }
  const headline =
    snapshot.activeCount > 0
      ? `${snapshot.activeCount} active`
      : snapshot.recentFailureCount > 0
        ? `${snapshot.recentFailureCount} recent failure${snapshot.recentFailureCount === 1 ? "" : "s"}`
        : `latest ${task.status.replaceAll("_", " ")}`;
  const title = formatTaskStatusTitle(task);
  const detail = formatTaskStatusDetail(task);
  const parts = [headline, task.runtime, title, detail].filter(Boolean);
  return parts.length ? `📌 Tasks: ${parts.join(" · ")}` : undefined;
}

async function resolveModelOverride(params: {
  cfg: OpenClawConfig;
  raw: string;
  sessionEntry?: SessionEntry;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<
  | { kind: "reset" }
  | {
      kind: "set";
      provider: string;
      model: string;
      isDefault: boolean;
    }
> {
  const raw = normalizeToolModelOverride(params.raw);
  if (!raw) {
    return { kind: "reset" };
  }

  const configDefault = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const currentProvider = params.sessionEntry?.providerOverride?.trim() || configDefault.provider;
  const currentModel = params.sessionEntry?.modelOverride?.trim() || configDefault.model;

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: currentProvider,
  });
  const catalog = await loadPreparedModelCatalog({
    config: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    readOnly: true,
    ...(params.sessionEntry?.spawnedWorkspaceDir
      ? { workspaceDir: params.sessionEntry.spawnedWorkspaceDir }
      : {}),
  });
  const workspaceDir = params.sessionEntry?.spawnedWorkspaceDir ?? params.workspaceDir;
  const manifestMetadataSnapshot =
    params.metadataSnapshot &&
    params.metadataSnapshot.pluginIds === undefined &&
    isPluginMetadataSnapshotCompatible({
      snapshot: params.metadataSnapshot,
      config: params.cfg,
      env: process.env,
      workspaceDir,
    })
      ? params.metadataSnapshot
      : resolvePluginMetadataSnapshot({
          config: params.cfg,
          ...(workspaceDir ? { workspaceDir } : {}),
          env: process.env,
        });
  const modelManifestContext = {
    manifestPlugins: manifestMetadataSnapshot?.plugins,
  };
  const policy = createModelVisibilityPolicy({
    cfg: params.cfg,
    catalog,
    defaultProvider: currentProvider,
    defaultModel: currentModel,
    agentId: params.agentId,
    allowManifestNormalization: true,
    allowPluginNormalization: true,
    ...modelManifestContext,
  });

  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    raw,
    defaultProvider: currentProvider,
    aliasIndex,
    allowManifestNormalization: true,
    allowPluginNormalization: true,
    ...modelManifestContext,
  });
  if (!resolved) {
    throw new Error(`Unrecognized model "${raw}".`);
  }
  const key = modelKey(resolved.ref.provider, resolved.ref.model);
  if (!policy.allowsKey(key)) {
    throw new Error(`Model "${key}" is not allowed.`);
  }
  const isDefault =
    resolved.ref.provider === configDefault.provider && resolved.ref.model === configDefault.model;
  return {
    kind: "set",
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    isDefault,
  };
}

export function createSessionStatusTool(opts?: {
  agentSessionKey?: string;
  /**
   * The actual live run session key. When the tool is constructed with a sandbox/policy
   * session key (e.g. a Telegram direct peer key), this allows `session_status({sessionKey:
   * "current"})` to resolve to the live run session instead of the stale sandbox key.
   */
  runSessionKey?: string;
  config?: OpenClawConfig;
  sandboxed?: boolean;
  activeModelProvider?: string;
  activeModelId?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  /** Active live-run route, kept separate from the persisted/origin delivery route. */
  activeDeliveryContext?: DeliveryContext;
}): AnyAgentTool {
  return {
    label: "Session Status",
    name: "session_status",
    displaySummary: SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
    description: describeSessionStatusTool(),
    parameters: SessionStatusToolSchema,
    outputSchema: SessionStatusOutputSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const changesSince = readNonNegativeIntegerParam(params, "changesSince");
      const cfg = opts?.config ?? getRuntimeConfig();
      const { mainKey, alias, effectiveRequesterKey } = resolveSandboxedSessionToolContext({
        cfg,
        agentSessionKey: opts?.agentSessionKey,
        sandboxed: opts?.sandboxed,
      });
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const configuredDefaultAgentId = resolveDefaultAgentId(cfg);
      const requesterAgentId = resolveAgentIdFromSessionKey(
        opts?.agentSessionKey ?? effectiveRequesterKey,
        configuredDefaultAgentId,
      );
      const visibilityRequesterKey = (opts?.agentSessionKey ?? effectiveRequesterKey).trim();
      const usesLegacyMainAlias = alias === mainKey;
      const isLegacyMainVisibilityKey = (sessionKey: string) => {
        const trimmed = sessionKey.trim();
        return usesLegacyMainAlias && (trimmed === "main" || trimmed === mainKey);
      };
      const resolveVisibilityMainSessionKey = (sessionAgentId: string) => {
        const requesterParsed = parseAgentSessionKey(visibilityRequesterKey);
        if (
          resolveAgentIdFromSessionKey(visibilityRequesterKey, configuredDefaultAgentId) ===
            sessionAgentId &&
          (requesterParsed?.rest === mainKey || isLegacyMainVisibilityKey(visibilityRequesterKey))
        ) {
          return visibilityRequesterKey;
        }
        return buildAgentMainSessionKey({
          agentId: sessionAgentId,
          mainKey,
        });
      };
      const normalizeVisibilityTargetSessionKey = (sessionKey: string, sessionAgentId: string) => {
        const trimmed = sessionKey.trim();
        if (!trimmed) {
          return trimmed;
        }
        if (trimmed.startsWith("agent:")) {
          const parsed = parseAgentSessionKey(trimmed);
          if (parsed?.rest === mainKey) {
            return resolveVisibilityMainSessionKey(sessionAgentId);
          }
          return trimmed;
        }
        // Preserve legacy bare main keys for requester tree checks.
        if (isLegacyMainVisibilityKey(trimmed)) {
          return resolveVisibilityMainSessionKey(sessionAgentId);
        }
        return trimmed;
      };
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "status",
        defaultAgentId: resolveDefaultAgentId(cfg),
        requesterSessionKey: visibilityRequesterKey,
        visibility: resolveEffectiveSessionToolsVisibility({
          cfg,
          sandboxed: opts?.sandboxed === true,
        }),
        a2aPolicy,
      });

      const requestedKeyParam = readStringParam(params, "sessionKey");
      const isImplicitRunSessionStatus =
        requestedKeyParam === undefined && Boolean(opts?.runSessionKey?.trim());
      let requestedKeyRaw = requestedKeyParam ?? opts?.agentSessionKey;

      // No-arg status should prefer the live run session when available (#82669).
      if (isImplicitRunSessionStatus) {
        requestedKeyRaw = opts?.runSessionKey;
      }
      let requestedKeyInput = requestedKeyRaw?.trim() ?? "";

      // Track whether this is a semantic-current request (literal "current" or a
      // current-client alias) BEFORE any rewrite, so visibility treats it as self.
      const isSemanticCurrentRequest =
        requestedKeyInput === "current" ||
        isImplicitRunSessionStatus ||
        Boolean(
          resolveCurrentSessionClientAlias({
            key: requestedKeyInput,
            requesterInternalKey: effectiveRequesterKey,
          }),
        );

      // Resolve semantic "current" to the live run session key for lookup purposes (#76708).
      // In sandboxed channel runs there may be no separate runSessionKey because the sandbox
      // key already is the live requester; avoid probing literal "current" through the gateway.
      if (requestedKeyInput === "current" && (opts?.runSessionKey || opts?.sandboxed === true)) {
        requestedKeyRaw = opts.runSessionKey ?? effectiveRequesterKey;
        requestedKeyInput = requestedKeyRaw?.trim() ?? "";
      }

      const currentSessionAlias = resolveCurrentSessionClientAlias({
        key: requestedKeyInput,
        requesterInternalKey: effectiveRequesterKey,
      });
      if (currentSessionAlias) {
        requestedKeyRaw = opts?.runSessionKey ?? currentSessionAlias;
        requestedKeyInput = requestedKeyRaw?.trim() ?? "";
      }
      const effectiveRequesterLookupKey = effectiveRequesterKey.trim();
      let resolvedViaSessionId = false;
      let resolvedViaImplicitCurrentFallback = false;
      if (!requestedKeyInput) {
        throw new Error("sessionKey required");
      }
      requestedKeyRaw = requestedKeyInput;
      const ensureAgentAccess = (targetAgentId: string) => {
        if (targetAgentId === requesterAgentId) {
          return;
        }
        // Gate cross-agent access behind tools.agentToAgent settings.
        if (!a2aPolicy.enabled) {
          throw new Error(
            "Agent-to-agent status is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.",
          );
        }
        if (!a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
          throw new Error("Agent-to-agent session status denied by tools.agentToAgent.allow.");
        }
      };

      if (requestedKeyInput.startsWith("agent:") && !isSemanticCurrentRequest) {
        const requestedAgentId = resolveAgentIdFromSessionKey(
          requestedKeyInput,
          configuredDefaultAgentId,
        );
        ensureAgentAccess(requestedAgentId);
        const access = visibilityGuard.check(
          normalizeVisibilityTargetSessionKey(requestedKeyInput, requestedAgentId),
        );
        if (!access.allowed) {
          throw new Error(access.error);
        }
      }

      const isExplicitAgentKey = requestedKeyInput.startsWith("agent:");
      let agentId = isExplicitAgentKey
        ? resolveAgentIdFromSessionKey(requestedKeyInput, configuredDefaultAgentId)
        : requesterAgentId;
      let storePath = resolveStorePath(cfg.session?.store, { agentId });
      let storeScopedRequesterKey = resolveStoreScopedRequesterKey({
        requesterKey: effectiveRequesterKey,
        agentId,
        mainKey,
      });

      // Resolve against the requester-scoped store first to avoid leaking default agent data.
      let resolved = resolveSessionStatusEntry({
        cfg,
        agentId,
        keyRaw: requestedKeyRaw,
        alias,
        mainKey,
        requesterInternalKey: storeScopedRequesterKey,
        includeAliasFallback: requestedKeyInput !== "current",
      });

      if (
        !resolved &&
        (requestedKeyInput === "current" || shouldResolveSessionIdInput(requestedKeyInput))
      ) {
        const resolvedSession = await resolveSessionReference({
          sessionKey: requestedKeyInput,
          alias,
          mainKey,
          requesterInternalKey: effectiveRequesterKey,
          restrictToSpawned: opts?.sandboxed === true,
        });
        if (resolvedSession.ok && resolvedSession.resolvedViaSessionId) {
          const visibleSession = await resolveVisibleSessionReference({
            action: "status",
            resolvedSession,
            requesterSessionKey: effectiveRequesterKey,
            restrictToSpawned: opts?.sandboxed === true,
            visibilitySessionKey: requestedKeyInput,
          });
          if (!visibleSession.ok) {
            throw new Error("Session status visibility is restricted to the current session tree.");
          }
          // If resolution points at another agent, enforce A2A policy before switching stores.
          ensureAgentAccess(
            resolveAgentIdFromSessionKey(visibleSession.key, configuredDefaultAgentId),
          );
          resolvedViaSessionId = true;
          requestedKeyRaw = visibleSession.key;
          requestedKeyInput = requestedKeyRaw.trim();
          agentId = resolveAgentIdFromSessionKey(visibleSession.key, configuredDefaultAgentId);
          storePath = resolveStorePath(cfg.session?.store, { agentId });
          storeScopedRequesterKey = resolveStoreScopedRequesterKey({
            requesterKey: effectiveRequesterKey,
            agentId,
            mainKey,
          });
          resolved = resolveSessionStatusEntry({
            cfg,
            agentId,
            keyRaw: requestedKeyRaw,
            alias,
            mainKey,
            requesterInternalKey: storeScopedRequesterKey,
          });
        } else if (!resolvedSession.ok && opts?.sandboxed === true) {
          throw new Error("Session status visibility is restricted to the current session tree.");
        }
      }

      if (!resolved && requestedKeyInput === "current" && effectiveRequesterLookupKey) {
        resolved = resolveSessionStatusEntry({
          cfg,
          agentId,
          keyRaw: effectiveRequesterLookupKey,
          alias,
          mainKey,
          requesterInternalKey: storeScopedRequesterKey,
          includeAliasFallback: false,
        });
      }

      if (!resolved && requestedKeyInput === "current") {
        resolved = resolveSessionStatusEntry({
          cfg,
          agentId,
          keyRaw: requestedKeyRaw,
          alias,
          mainKey,
          requesterInternalKey: storeScopedRequesterKey,
          includeAliasFallback: true,
        });
      }

      if (!resolved && requestedKeyParam === undefined) {
        for (const fallbackKey of listImplicitDefaultDirectFallbackKeys({
          keyRaw: requestedKeyRaw,
          mainKey,
        })) {
          resolved = resolveSessionStatusEntry({
            cfg,
            agentId,
            keyRaw: fallbackKey,
            alias,
            mainKey,
            requesterInternalKey: storeScopedRequesterKey,
            includeAliasFallback: true,
          });
          if (resolved) {
            resolvedViaImplicitCurrentFallback = true;
            break;
          }
        }
      }

      if (!resolved) {
        const runSessionFallbackKey = opts?.runSessionKey?.trim();
        const fallback = resolveImplicitCurrentSessionFallback({
          agentId,
          allowFallback: isSemanticCurrentRequest || requestedKeyParam === undefined,
          cfg,
          fallbackKey:
            (isSemanticCurrentRequest || isImplicitRunSessionStatus) && runSessionFallbackKey
              ? runSessionFallbackKey
              : isSemanticCurrentRequest
                ? effectiveRequesterLookupKey
                : storeScopedRequesterKey,
        });
        if (fallback) {
          resolved = fallback;
          resolvedViaImplicitCurrentFallback = true;
        }
      }

      if (!resolved) {
        const kind = shouldResolveSessionIdInput(requestedKeyInput) ? "sessionId" : "sessionKey";
        throw new Error(`Unknown ${kind}: ${requestedKeyInput}`);
      }

      // Preserve caller-scoped raw-key/current lookups as "self" for visibility checks.
      const shouldTreatVisibilityTargetAsSelf =
        isSemanticCurrentRequest ||
        resolvedViaImplicitCurrentFallback ||
        (!resolvedViaSessionId &&
          (requestedKeyInput === "current" || resolved.key === requestedKeyInput));
      const visibilityTargetKey = shouldTreatVisibilityTargetAsSelf
        ? visibilityRequesterKey
        : normalizeVisibilityTargetSessionKey(resolved.key, agentId);
      const access = visibilityGuard.check(visibilityTargetKey);
      if (!access.allowed) {
        throw new Error(access.error);
      }
      let scopedResolved = resolved;

      return await runWithScopedSessionAccess({
        cfg,
        expectedSessionId: access.expectedSessionId,
        targetSessionKey: scopedResolved.key,
        run: async () => {
          const configured = resolveDefaultModelForAgent({ cfg, agentId });
          const selectedAgentDir = resolveAgentDir(cfg, agentId);
          const selectedWorkspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
          const modelRaw = readStringParam(params, "model");
          let changedModel = false;
          if (typeof modelRaw === "string") {
            const selection = await resolveModelOverride({
              cfg,
              raw: modelRaw,
              sessionEntry: scopedResolved.entry,
              agentId,
              agentDir: selectedAgentDir,
              workspaceDir: selectedWorkspaceDir,
              metadataSnapshot: opts?.metadataSnapshot,
            });
            const modelSelection =
              selection.kind === "reset"
                ? {
                    provider: configured.provider,
                    model: configured.model,
                    isDefault: true,
                  }
                : {
                    provider: selection.provider,
                    model: selection.model,
                    isDefault: selection.isDefault,
                  };
            const nextEntry: SessionEntry = { ...scopedResolved.entry };
            const applied = applyModelOverrideToSessionEntry({
              entry: nextEntry,
              selection: modelSelection,
              markLiveSwitchPending: true,
            });
            if (applied.updated) {
              const patchResult = await patchSessionEntryWithKey(
                {
                  agentId,
                  sessionKey: scopedResolved.key,
                  storePath,
                },
                (entry, context) => {
                  const persistedEntryPatch: SessionEntry = { ...entry };
                  applyModelOverrideToSessionEntry({
                    entry: persistedEntryPatch,
                    selection: modelSelection,
                    markLiveSwitchPending: true,
                  });
                  if (
                    !persistedEntryPatch.sessionId.trim() &&
                    !context.existingEntry?.sessionId?.trim()
                  ) {
                    persistedEntryPatch.sessionId = randomUUID();
                  }
                  return persistedEntryPatch;
                },
                {
                  fallbackEntry: scopedResolved.persisted ? undefined : scopedResolved.entry,
                  replaceEntry: true,
                },
              );
              if (!patchResult) {
                throw new Error(`Unknown sessionKey: ${scopedResolved.key}`);
              }
              const persistedEntry = patchResult.entry;
              scopedResolved = {
                entry: persistedEntry,
                key: patchResult.sessionKey,
                persisted: true,
              };
              triggerSessionPatchHook({
                cfg,
                sessionEntry: persistedEntry,
                sessionKey: patchResult.sessionKey,
                patch: {
                  key: patchResult.sessionKey,
                  model:
                    selection.kind === "reset" ? null : `${selection.provider}/${selection.model}`,
                },
              });
              changedModel = true;
            }
          }

          const activeModelId = opts?.activeModelId?.trim();
          const activeModelProvider = opts?.activeModelProvider?.trim();
          const isImplicitCurrentRequest = requestedKeyParam === undefined;
          const liveSessionKeys = [
            opts?.runSessionKey,
            storeScopedRequesterKey,
            effectiveRequesterKey,
            visibilityRequesterKey,
          ];
          const activeModelIdentity = resolveActiveStatusModelIdentity({
            activeModelId,
            activeModelProvider,
            isImplicitCurrentRequest,
            isSemanticCurrentRequest,
            liveSessionKeys,
            modelRaw,
            resolvedKey: scopedResolved.key,
          });
          const runtimeModelIdentity = activeModelIdentity
            ? activeModelIdentity
            : resolveSessionModelIdentityRef(
                cfg,
                scopedResolved.entry,
                agentId,
                `${configured.provider}/${configured.model}`,
              );
          const hasExplicitModelOverride = Boolean(
            !activeModelIdentity &&
            (scopedResolved.entry.providerOverride?.trim() ||
              scopedResolved.entry.modelOverride?.trim()),
          );
          const runtimeProviderForCard = runtimeModelIdentity.provider?.trim();
          const runtimeModelForCard = runtimeModelIdentity.model.trim();
          const defaultProviderForCard = hasExplicitModelOverride
            ? configured.provider
            : (runtimeProviderForCard ?? "");
          const defaultModelForCard = hasExplicitModelOverride
            ? configured.model
            : runtimeModelForCard || configured.model;
          const statusSessionEntry = activeModelIdentity
            ? withActiveStatusModelIdentity(scopedResolved.entry, activeModelIdentity)
            : !hasExplicitModelOverride && !runtimeProviderForCard && runtimeModelForCard
              ? { ...scopedResolved.entry, providerOverride: "" }
              : scopedResolved.entry;
          const providerOverrideForCard = statusSessionEntry.providerOverride?.trim();
          const providerForCard = providerOverrideForCard ?? defaultProviderForCard;
          const primaryModelLabel =
            providerForCard && defaultModelForCard
              ? `${providerForCard}/${defaultModelForCard}`
              : defaultModelForCard;
          const isGroup =
            statusSessionEntry.chatType === "group" ||
            statusSessionEntry.chatType === "channel" ||
            scopedResolved.key.includes(":group:") ||
            scopedResolved.key.includes(":channel:");
          const taskLine = formatSessionTaskLine({
            relatedSessionKey: scopedResolved.key,
            callerOwnerKey: visibilityRequesterKey,
          });
          // Tool status may read persisted/configured facts, but must not start provider discovery.
          const thinkingCatalog = await loadPreparedModelCatalog({
            config: cfg,
            agentId,
            agentDir: selectedAgentDir,
            readOnly: true,
            ...(statusSessionEntry.spawnedWorkspaceDir
              ? { workspaceDir: statusSessionEntry.spawnedWorkspaceDir }
              : {}),
          });
          const { buildStatusText } = await loadCommandsStatusRuntime();
          const statusText = await buildStatusText({
            cfg,
            sessionEntry: statusSessionEntry,
            sessionKey: scopedResolved.key,
            parentSessionKey: statusSessionEntry.parentSessionKey,
            sessionScope: cfg.session?.scope,
            storePath,
            statusChannel: sessionDeliveryChannel(statusSessionEntry) ?? "unknown",
            workspaceDir: statusSessionEntry.spawnedWorkspaceDir,
            provider: providerForCard,
            model: defaultModelForCard,
            thinkingCatalog,
            resolvedThinkLevel: statusSessionEntry.thinkingLevel as ThinkLevel | undefined,
            resolvedFastMode: statusSessionEntry.fastMode,
            resolvedVerboseLevel: (statusSessionEntry.verboseLevel ?? "off") as VerboseLevel,
            resolvedReasoningLevel: (statusSessionEntry.reasoningLevel ?? "off") as ReasoningLevel,
            resolvedElevatedLevel: statusSessionEntry.elevatedLevel as ElevatedLevel | undefined,
            resolveDefaultThinkingLevel: () =>
              resolveThinkingDefaultWithRuntimeCatalog({
                cfg,
                provider: providerForCard,
                model: defaultModelForCard,
                loadRuntimeCatalog: () =>
                  loadPreparedModelCatalog({
                    config: cfg,
                    agentId,
                    agentDir: selectedAgentDir,
                    readOnly: true,
                  }),
              }),
            isGroup,
            defaultGroupActivation: () => "mention",
            taskLineOverride: taskLine,
            skipDefaultTaskLookup: true,
            primaryModelLabelOverride: primaryModelLabel,
            ...(providerForCard ? {} : { modelAuthOverride: undefined }),
            includeTranscriptUsage: true,
          });
          const fullStatusText =
            taskLine && !statusText.includes(taskLine) ? `${statusText}\n${taskLine}` : statusText;
          const resultOverrideProvider = statusSessionEntry.providerOverride?.trim();
          const resultOverrideModel = statusSessionEntry.modelOverride?.trim();
          const liveSessionKeySet = new Set(
            liveSessionKeys
              .map((value) => value?.trim())
              .filter((value): value is string => Boolean(value)),
          );
          const activeRouteRunSessionKey = opts?.runSessionKey?.trim();
          const isLiveRouteSession = activeRouteRunSessionKey
            ? scopedResolved.key.trim() === activeRouteRunSessionKey
            : liveSessionKeySet.has(scopedResolved.key.trim());
          const routeDetails = buildSessionStatusRouteDetails({
            entry: statusSessionEntry,
            sessionKey: scopedResolved.key,
            activeDeliveryContext: opts?.activeDeliveryContext,
            isLiveRunSession: isLiveRouteSession,
          });
          const routeContextText = formatSessionStatusRouteContext(routeDetails);
          const stateVersion = getSessionStateVersion(scopedResolved.key, agentId);
          const rawStateChanges =
            changesSince !== undefined
              ? listSessionStateEventsSince(scopedResolved.key, agentId, changesSince, 200)
              : undefined;
          const stateChanges = rawStateChanges
            ? compactSessionStateChanges(rawStateChanges)
            : undefined;
          const extraBlocks = [
            routeContextText,
            rawStateChanges
              ? formatSessionStateChanges({ stateVersion, stateChanges: rawStateChanges })
              : undefined,
          ].filter((block): block is string => Boolean(block));
          const visibleStatusText =
            extraBlocks.length > 0
              ? `${fullStatusText}\n\n${extraBlocks.join("\n\n")}`
              : fullStatusText;
          const modelOverrideForResult =
            modelRaw === undefined
              ? undefined
              : resultOverrideModel
                ? resultOverrideProvider
                  ? `${resultOverrideProvider}/${resultOverrideModel}`
                  : resultOverrideModel
                : null;

          return {
            content: [{ type: "text", text: visibleStatusText }],
            details: {
              ok: true,
              sessionKey: scopedResolved.key,
              changedModel,
              stateVersion,
              ...(stateChanges ? { stateChanges } : {}),
              ...(modelRaw !== undefined
                ? {
                    model: resultOverrideModel ?? defaultModelForCard,
                    ...((resultOverrideProvider ?? providerForCard)
                      ? { modelProvider: resultOverrideProvider ?? providerForCard }
                      : {}),
                    modelOverride: modelOverrideForResult,
                  }
                : {}),
              statusText: visibleStatusText,
              ...routeDetails,
            },
          };
        },
      });
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
