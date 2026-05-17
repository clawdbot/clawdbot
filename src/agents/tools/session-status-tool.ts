import { Type } from "typebox";
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "../../auto-reply/thinking.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadSessionStore,
  mergeSessionEntry,
  resolveStorePath,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { resolveSessionModelIdentityRef } from "../../gateway/session-utils.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { BuildStatusTextParams } from "../../status/status-text.types.js";
import { buildTaskStatusSnapshotForRelatedSessionKeyForOwner } from "../../tasks/task-owner-access.js";
import { formatTaskStatusDetail, formatTaskStatusTitle } from "../../tasks/task-status.js";
import { loadModelCatalog } from "../model-catalog.js";
import {
  buildModelAliasIndex,
  modelKey,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  resolveThinkingDefaultWithRuntimeCatalog,
} from "../model-selection.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import {
  describeSessionStatusTool,
  SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { normalizeToolModelOverride, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveCurrentSessionClientAlias,
  resolveEffectiveSessionToolsVisibility,
  resolveInternalSessionKey,
  resolveSandboxedSessionToolContext,
  resolveSessionReference,
  resolveVisibleSessionReference,
  shouldResolveSessionIdInput,
} from "./sessions-helpers.js";

const SessionStatusToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
});

type CommandsStatusRuntimeModule = {
  buildStatusText: (params: BuildStatusTextParams) => Promise<string>;
};

const commandsStatusRuntimeLoader = createLazyImportLoader<CommandsStatusRuntimeModule>(
  () => import("./session-status.runtime.js") as Promise<CommandsStatusRuntimeModule>,
);

function loadCommandsStatusRuntime(): Promise<CommandsStatusRuntimeModule> {
  return commandsStatusRuntimeLoader.load();
}

function resolveSessionEntry(params: {
  store: Record<string, SessionEntry>;
  keyRaw: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  includeAliasFallback?: boolean;
}): { key: string; entry: SessionEntry } | null {
  const keyRaw = params.keyRaw.trim();
  if (!keyRaw) {
    return null;
  }
  const includeAliasFallback = params.includeAliasFallback ?? true;
  const internal = resolveInternalSessionKey({
    key: keyRaw,
    alias: params.alias,
    mainKey: params.mainKey,
    requesterInternalKey: params.requesterInternalKey,
  });

  const candidates: string[] = [keyRaw];
  if (!keyRaw.startsWith("agent:")) {
    candidates.push(`agent:${DEFAULT_AGENT_ID}:${keyRaw}`);
  }
  if (includeAliasFallback && internal !== keyRaw) {
    candidates.push(internal);
  }
  if (includeAliasFallback && !keyRaw.startsWith("agent:")) {
    const agentInternal = `agent:${DEFAULT_AGENT_ID}:${internal}`;
    const agentRaw = `agent:${DEFAULT_AGENT_ID}:${keyRaw}`;
    if (agentInternal !== agentRaw) {
      candidates.push(agentInternal);
    }
  }
  if (includeAliasFallback && (keyRaw === "main" || keyRaw === "current")) {
    const defaultMainKey = buildAgentMainSessionKey({
      agentId: DEFAULT_AGENT_ID,
      mainKey: params.mainKey,
    });
    if (!candidates.includes(defaultMainKey)) {
      candidates.push(defaultMainKey);
    }
  }

  for (const key of candidates) {
    const entry = params.store[key];
    if (entry) {
      return { key, entry };
    }
  }

  return null;
}

function resolveStoreScopedRequesterKey(params: {
  requesterKey: string;
  agentId: string;
  mainKey: string;
}) {
  const parsed = parseAgentSessionKey(params.requesterKey);
  if (!parsed || parsed.agentId !== params.agentId) {
    return params.requesterKey;
  }
  return parsed.rest === params.mainKey ? params.mainKey : params.requesterKey;
}

function synthesizeImplicitCurrentSessionEntry(): SessionEntry {
  return {
    sessionId: "",
    updatedAt: Date.now(),
  };
}

function resolveImplicitCurrentSessionFallback(params: {
  allowFallback: boolean;
  fallbackKey: string;
}): { key: string; entry: SessionEntry } | null {
  const fallbackKey = params.fallbackKey.trim();
  if (!params.allowFallback || !fallbackKey) {
    return null;
  }
  return {
    key: fallbackKey,
    entry: synthesizeImplicitCurrentSessionEntry(),
  };
}

function listImplicitDefaultDirectFallbackKeys(params: {
  keyRaw: string;
  mainKey: string;
}): string[] {
  const parsed = parseAgentSessionKey(params.keyRaw.trim());
  if (!parsed) {
    return [];
  }
  const parts = parsed.rest.split(":");
  if (parts.length < 4 || parts[1] !== "default" || parts[2] !== "direct") {
    return [];
  }
  const [channel, , , ...peerParts] = parts;
  if (!channel || peerParts.length === 0) {
    return [];
  }
  const candidates = [
    `agent:${parsed.agentId}:${channel}:direct:${peerParts.join(":")}`,
    buildAgentMainSessionKey({
      agentId: parsed.agentId,
      mainKey: params.mainKey,
    }),
    params.mainKey,
  ];
  return [...new Set(candidates)];
}

type ActiveStatusModelIdentity = { provider?: string; model: string };

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
  const catalog = await loadModelCatalog({ config: params.cfg });
  const policy = createModelVisibilityPolicy({
    cfg: params.cfg,
    catalog,
    defaultProvider: currentProvider,
    defaultModel: currentModel,
    agentId: params.agentId,
  });

  const resolved = resolveModelRefFromString({
    raw,
    defaultProvider: currentProvider,
    aliasIndex,
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
}): AnyAgentTool {
  return {
    label: "Session Status",
    name: "session_status",
    displaySummary: SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
    description: describeSessionStatusTool(),
    parameters: SessionStatusToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? getRuntimeConfig();
      const { mainKey, alias, effectiveRequesterKey } = resolveSandboxedSessionToolContext({
        cfg,
        agentSessionKey: opts?.agentSessionKey,
        sandboxed: opts?.sandboxed,
      });
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const requesterAgentId = resolveAgentIdFromSessionKey(
        opts?.agentSessionKey ?? effectiveRequesterKey,
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
          resolveAgentIdFromSessionKey(visibilityRequesterKey) === sessionAgentId &&
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

      // Track whether this is a semantic-current request (literal "current" or a
      // current-client alias) BEFORE any rewrite, so visibility treats it as self.
      const isSemanticCurrentRequest =
        requestedKeyRaw === "current" ||
        isImplicitRunSessionStatus ||
        Boolean(
          resolveCurrentSessionClientAlias({
            key: requestedKeyRaw ?? "",
            requesterInternalKey: effectiveRequesterKey,
          }),
        );

      // Resolve semantic "current" to the live run session key for lookup purposes (#76708).
      // In sandboxed channel runs there may be no separate runSessionKey because the sandbox
      // key already is the live requester; avoid probing literal "current" through the gateway.
      if (requestedKeyRaw === "current" && (opts?.runSessionKey || opts?.sandboxed === true)) {
        requestedKeyRaw = opts.runSessionKey ?? effectiveRequesterKey;
      }

      const currentSessionAlias = resolveCurrentSessionClientAlias({
        key: requestedKeyRaw ?? "",
        requesterInternalKey: effectiveRequesterKey,
      });
      if (currentSessionAlias) {
        requestedKeyRaw = opts?.runSessionKey ?? currentSessionAlias;
      }
      const requestedKeyInput = requestedKeyRaw?.trim() ?? "";
      let resolvedViaSessionId = false;
      let resolvedViaImplicitCurrentFallback = false;
      if (!requestedKeyRaw?.trim()) {
        throw new Error("sessionKey required");
      }
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

      if (requestedKeyRaw.startsWith("agent:") && !isSemanticCurrentRequest) {
        const requestedAgentId = resolveAgentIdFromSessionKey(requestedKeyRaw);
        ensureAgentAccess(requestedAgentId);
        const access = visibilityGuard.check(
          normalizeVisibilityTargetSessionKey(requestedKeyRaw, requestedAgentId),
        );
        if (!access.allowed) {
          throw new Error(access.error);
        }
      }

      const isExplicitAgentKey = requestedKeyRaw.startsWith("agent:");
      let agentId = isExplicitAgentKey
        ? resolveAgentIdFromSessionKey(requestedKeyRaw)
        : requesterAgentId;
      let storePath = resolveStorePath(cfg.session?.store, { agentId });
      let store = loadSessionStore(storePath);
      let storeScopedRequesterKey = resolveStoreScopedRequesterKey({
        requesterKey: effectiveRequesterKey,
        agentId,
        mainKey,
      });

      // Resolve against the requester-scoped store first to avoid leaking default agent data.
      let resolved = resolveSessionEntry({
        store,
        keyRaw: requestedKeyRaw,
        alias,
        mainKey,
        requesterInternalKey: storeScopedRequesterKey,
        includeAliasFallback: requestedKeyRaw !== "current",
      });

      if (
        !resolved &&
        (requestedKeyRaw === "current" || shouldResolveSessionIdInput(requestedKeyRaw))
      ) {
        const resolvedSession = await resolveSessionReference({
          sessionKey: requestedKeyRaw,
          alias,
          mainKey,
          requesterInternalKey: effectiveRequesterKey,
          restrictToSpawned: opts?.sandboxed === true,
        });
        if (resolvedSession.ok && resolvedSession.resolvedViaSessionId) {
          const visibleSession = await resolveVisibleSessionReference({
            resolvedSession,
            requesterSessionKey: effectiveRequesterKey,
            restrictToSpawned: opts?.sandboxed === true,
            visibilitySessionKey: requestedKeyRaw,
          });
          if (!visibleSession.ok) {
            throw new Error("Session status visibility is restricted to the current session tree.");
          }
          // If resolution points at another agent, enforce A2A policy before switching stores.
          ensureAgentAccess(resolveAgentIdFromSessionKey(visibleSession.key));
          resolvedViaSessionId = true;
          requestedKeyRaw = visibleSession.key;
          agentId = resolveAgentIdFromSessionKey(visibleSession.key);
          storePath = resolveStorePath(cfg.session?.store, { agentId });
          store = loadSessionStore(storePath);
          storeScopedRequesterKey = resolveStoreScopedRequesterKey({
            requesterKey: effectiveRequesterKey,
            agentId,
            mainKey,
          });
          resolved = resolveSessionEntry({
            store,
            keyRaw: requestedKeyRaw,
            alias,
            mainKey,
            requesterInternalKey: storeScopedRequesterKey,
          });
        } else if (!resolvedSession.ok && opts?.sandboxed === true) {
          throw new Error("Session status visibility is restricted to the current session tree.");
        }
      }

      if (!resolved && requestedKeyRaw === "current") {
        resolved = resolveSessionEntry({
          store,
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
          resolved = resolveSessionEntry({
            store,
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
        const fallback = resolveImplicitCurrentSessionFallback({
          allowFallback: isSemanticCurrentRequest || requestedKeyParam === undefined,
          fallbackKey:
            (isSemanticCurrentRequest || isImplicitRunSessionStatus) && opts?.runSessionKey
              ? opts.runSessionKey
              : storeScopedRequesterKey,
        });
        if (fallback) {
          resolved = fallback;
          resolvedViaImplicitCurrentFallback = true;
        }
      }

      if (!resolved) {
        const kind = shouldResolveSessionIdInput(requestedKeyRaw) ? "sessionId" : "sessionKey";
        throw new Error(`Unknown ${kind}: ${requestedKeyRaw}`);
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

      const configured = resolveDefaultModelForAgent({ cfg, agentId });
      const modelRaw = readStringParam(params, "model");
      let changedModel = false;
      if (typeof modelRaw === "string") {
        const selection = await resolveModelOverride({
          cfg,
          raw: modelRaw,
          sessionEntry: resolved.entry,
          agentId,
        });
        const nextEntry: SessionEntry = { ...resolved.entry };
        const applied = applyModelOverrideToSessionEntry({
          entry: nextEntry,
          selection:
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
                },
          markLiveSwitchPending: true,
        });
        if (applied.updated) {
          const persistedEntry = nextEntry.sessionId.trim()
            ? nextEntry
            : (() => {
                const persistedEntryPatch: Partial<SessionEntry> = { ...nextEntry };
                delete persistedEntryPatch.sessionId;
                const existingEntry = store[resolved.key];
                const existingWithValidSessionId = existingEntry?.sessionId?.trim()
                  ? existingEntry
                  : undefined;
                return mergeSessionEntry(existingWithValidSessionId, persistedEntryPatch);
              })();
          store[resolved.key] = persistedEntry;
          await updateSessionStore(storePath, (nextStore) => {
            nextStore[resolved.key] = persistedEntry;
          });
          resolved.entry = persistedEntry;
          triggerSessionPatchHook({
            cfg,
            sessionEntry: persistedEntry,
            sessionKey: resolved.key,
            patch: {
              key: resolved.key,
              model: selection.kind === "reset" ? null : `${selection.provider}/${selection.model}`,
            },
          });
          changedModel = true;
        }
      }

      const activeModelId = opts?.activeModelId?.trim();
      const activeModelProvider = opts?.activeModelProvider?.trim();
      const isImplicitCurrentRequest = requestedKeyParam === undefined;
      const activeModelIdentity = resolveActiveStatusModelIdentity({
        activeModelId,
        activeModelProvider,
        isImplicitCurrentRequest,
        isSemanticCurrentRequest,
        liveSessionKeys: [
          opts?.runSessionKey,
          storeScopedRequesterKey,
          effectiveRequesterKey,
          visibilityRequesterKey,
        ],
        modelRaw,
        resolvedKey: resolved.key,
      });
      const runtimeModelIdentity = activeModelIdentity
        ? activeModelIdentity
        : resolveSessionModelIdentityRef(
            cfg,
            resolved.entry,
            agentId,
            `${configured.provider}/${configured.model}`,
          );
      const hasExplicitModelOverride = Boolean(
        !activeModelIdentity &&
        (resolved.entry.providerOverride?.trim() || resolved.entry.modelOverride?.trim()),
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
        ? withActiveStatusModelIdentity(resolved.entry, activeModelIdentity)
        : !hasExplicitModelOverride && !runtimeProviderForCard && runtimeModelForCard
          ? { ...resolved.entry, providerOverride: "" }
          : resolved.entry;
      const providerOverrideForCard = statusSessionEntry.providerOverride?.trim();
      const providerForCard = providerOverrideForCard ?? defaultProviderForCard;
      const primaryModelLabel =
        providerForCard && defaultModelForCard
          ? `${providerForCard}/${defaultModelForCard}`
          : defaultModelForCard;
      const isGroup =
        statusSessionEntry.chatType === "group" ||
        statusSessionEntry.chatType === "channel" ||
        resolved.key.includes(":group:") ||
        resolved.key.includes(":channel:");
      const taskLine = formatSessionTaskLine({
        relatedSessionKey: resolved.key,
        callerOwnerKey: visibilityRequesterKey,
      });
      const { buildStatusText } = await loadCommandsStatusRuntime();
      const statusText = await buildStatusText({
        cfg,
        sessionEntry: statusSessionEntry,
        sessionKey: resolved.key,
        parentSessionKey: statusSessionEntry.parentSessionKey,
        sessionScope: cfg.session?.scope,
        storePath,
        statusChannel:
          statusSessionEntry.channel ??
          statusSessionEntry.lastChannel ??
          statusSessionEntry.origin?.provider ??
          "unknown",
        workspaceDir: statusSessionEntry.spawnedWorkspaceDir,
        provider: providerForCard,
        model: defaultModelForCard,
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
            loadModelCatalog: () => loadModelCatalog({ config: cfg }),
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
      const modelOverrideForResult =
        modelRaw === undefined
          ? undefined
          : resultOverrideModel
            ? resultOverrideProvider
              ? `${resultOverrideProvider}/${resultOverrideModel}`
              : resultOverrideModel
            : null;

      return {
        content: [{ type: "text", text: fullStatusText }],
        details: {
          ok: true,
          sessionKey: resolved.key,
          changedModel,
          ...(modelRaw !== undefined
            ? {
                model: resultOverrideModel ?? defaultModelForCard,
                ...((resultOverrideProvider ?? providerForCard)
                  ? { modelProvider: resultOverrideProvider ?? providerForCard }
                  : {}),
                modelOverride: modelOverrideForResult,
              }
            : {}),
          statusText: fullStatusText,
        },
      };
    },
  };
}
