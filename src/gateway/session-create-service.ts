import { randomUUID } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  type SessionVisibility,
  errorShape,
  missingScopeErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent.js";
import {
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "../agents/inherited-tool-deny.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import {
  forkSessionFromParentWithDecision,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
} from "../auto-reply/reply/session-fork.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  createSessionEntryWithTranscript,
  listSessionEntriesReadOnly,
  resolveSessionEntryAccessTarget,
} from "../config/sessions/session-accessor.js";
import {
  buildSessionCreationStamp,
  type SessionCreatedActor,
  type SessionCreatedVia,
} from "../config/sessions/session-entry-provenance.js";
import { inheritSessionSelection } from "../config/sessions/session-entry-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createInternalHookEvent,
  hasInternalHookListeners,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import {
  isIncognitoSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import {
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  isAgentHarnessSessionKeyOwnedBy,
} from "../sessions/agent-harness-session-key.js";
import { shouldPreserveSessionAuthProfileOverride } from "../sessions/auth-profile-preservation.js";
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import {
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { recordSessionCreated } from "../sessions/session-state-events.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import { buildForkedGatewaySessionEntry } from "./session-create-fork-entry.js";
import {
  type GatewaySessionTitleModelSelection,
  type PreparedGatewaySessionLifecycle,
  type PrepareGatewaySessionLifecycle,
  rollbackGatewaySessionPreparation,
} from "./session-lifecycle-preparation.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { isSessionVisibilityAllowed, resolveSessionVisibility } from "./session-sharing.js";
import {
  loadGatewaySessionEntryReadOnly,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";
import { projectSessionsPatchEntry, resolveSessionPatchModelSelection } from "./sessions-patch.js";

type TrustedCatalogSessionTarget = {
  model: string;
  agentRuntime: string;
  pluginOwnerId: string;
};

const loadSessionLifecycleRuntime = createLazyRuntimeModule(
  () => import("./server-methods/sessions.runtime.js"),
);

export function resolveSessionCreateModelSelection(
  cfg: OpenClawConfig,
  agentId: string,
  input: string | { model: string; agentRuntime?: string } | undefined,
  parentEntry?: SessionEntry,
): GatewaySessionTitleModelSelection | null {
  const model = normalizeOptionalString(typeof input === "string" ? input : input?.model);
  if (!model) {
    const inherited = inheritSessionSelection(parentEntry);
    return {
      providerOverride: inherited.providerOverride,
      modelOverride: inherited.modelOverride,
      agentRuntimeOverride: inherited.agentRuntimeOverride,
      authProfileOverride: inherited.authProfileOverride,
    };
  }
  const defaults = resolveDefaultModelForAgent({ cfg, agentId });
  // Reuse patch policy with the config-owned catalog projection. Persisted creation
  // remains the sole live-catalog availability validator.
  const resolved = resolveSessionPatchModelSelection({
    cfg,
    catalog: [],
    raw: model,
    defaultProvider: defaults.provider,
    defaultModel: defaults.model,
  });
  if (!resolved.ok) {
    return null;
  }
  const agentRuntimeOverride = normalizeOptionalAgentRuntimeId(
    typeof input === "string" ? undefined : input?.agentRuntime,
  );
  return {
    providerOverride: resolved.provider,
    modelOverride: resolved.model,
    ...(agentRuntimeOverride ? { agentRuntimeOverride } : {}),
    ...(resolved.profile ? { authProfileOverride: resolved.profile } : {}),
  };
}

async function existingModelSelectionWouldChange(params: {
  agentId: string;
  cfg: OpenClawConfig;
  catalogModel?: string;
  defaultModel: string;
  defaultProvider: string;
  existingEntry: SessionEntry;
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
  requestedModel?: string;
  requestedThinkingLevel?: string;
  subagentModelHint?: string;
}): Promise<boolean> {
  if (params.catalogModel) {
    // Public catalog creates cannot include a key, and the service rejects
    // catalog targets for existing rows. If a trusted caller reaches this,
    // keep catalog-owned model/runtime adoption fail-closed.
    return true;
  }
  const requestedThinkingLevel = normalizeOptionalString(params.requestedThinkingLevel);
  if (
    requestedThinkingLevel &&
    requestedThinkingLevel !== normalizeOptionalString(params.existingEntry.thinkingLevel)
  ) {
    return true;
  }
  const requestedModel = normalizeOptionalString(params.requestedModel);
  if (!requestedModel) {
    return false;
  }
  if (!params.loadGatewayModelCatalog) {
    // Public/TUI model selection paths provide the catalog loader used by the
    // patch resolver. Without it, an existing-row model request cannot prove
    // it is a no-op, so non-admin callers must not reach the mutation path.
    return true;
  }
  const catalog = await params.loadGatewayModelCatalog();
  const resolved = resolveSessionPatchModelSelection({
    cfg: params.cfg,
    catalog,
    raw: requestedModel,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    subagentModelHint: params.subagentModelHint,
  });
  if (!resolved.ok) {
    // Admin callers still receive the precise model error from sessions.patch.
    // Non-admin existing-row creates fail closed before that mutation path.
    return true;
  }
  let existingProvider =
    normalizeOptionalString(params.existingEntry.providerOverride) ?? params.defaultProvider;
  let existingModel =
    normalizeOptionalString(params.existingEntry.modelOverride) ?? params.defaultModel;
  if (!normalizeOptionalString(params.existingEntry.modelOverride) && params.subagentModelHint) {
    const resolvedSubagentDefault = resolveSessionPatchModelSelection({
      cfg: params.cfg,
      catalog,
      raw: params.subagentModelHint,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
    });
    if (!resolvedSubagentDefault.ok) {
      return true;
    }
    if (!normalizeOptionalString(params.existingEntry.providerOverride)) {
      existingProvider = resolvedSubagentDefault.provider;
    }
    existingModel = resolvedSubagentDefault.model;
  }
  const existingProfile = normalizeOptionalString(params.existingEntry.authProfileOverride);
  const requestedProfile = normalizeOptionalString(resolved.profile);
  const profileWouldChange =
    requestedProfile !== undefined
      ? requestedProfile !== existingProfile
      : existingProfile !== undefined &&
        !shouldPreserveSessionAuthProfileOverride({
          cfg: params.cfg,
          agentDir: resolveAgentDir(params.cfg, params.agentId),
          currentProvider:
            params.existingEntry.providerOverride ??
            params.existingEntry.modelProvider ??
            params.defaultProvider,
          entry: params.existingEntry,
          provider: resolved.provider,
        });
  return (
    resolved.provider !== existingProvider || resolved.model !== existingModel || profileWouldChange
  );
}

export function buildDashboardSessionKey(
  agentId: string,
  options: { incognito?: boolean } = {},
): string {
  const opaqueId = `${options.incognito ? "incognito-" : ""}${randomUUID()}`;
  return `agent:${agentId}:dashboard:${opaqueId}`;
}

type CreatedGatewaySession = {
  key: string;
  agentId: string;
  entry: SessionEntry;
  storePath: string;
};

type TrustedInitialSessionEntry = {
  agentHarnessId?: NonNullable<SessionEntry["agentHarnessId"]>;
  pluginOwnerId?: string;
  providerOverride?: string;
  modelOverride?: string;
  modelOverrideRouteResolution?: "resolved";
  cliSessionBindings?: SessionEntry["cliSessionBindings"];
  initializationPending?: true;
  modelSelectionLocked?: true;
  pluginExtensions?: SessionEntry["pluginExtensions"];
};

type CreateGatewaySessionResult =
  | {
      ok: true;
      key: string;
      agentId: string;
      entry: SessionEntry;
      resolved: { modelProvider: string; model: string };
      resetExisting: boolean;
    }
  | { ok: false; error: ErrorShape };

export async function createGatewaySession(params: {
  cfg: OpenClawConfig;
  key?: string;
  agentId?: string;
  label?: string;
  category?: string;
  model?: string;
  thinkingLevel?: string;
  /** Registry identity recorded only when this request creates a logical session node. */
  projectId?: string;
  incognito?: boolean;
  visibility?: SessionVisibility;
  /** Trusted catalog-owned model/runtime pair, persisted and locked together. */
  catalogTarget?: TrustedCatalogSessionTarget;
  parentSessionKey?: string;
  /**
   * Spawn-lineage depth declared by spawn-owned creations (visible subagent
   * sessions). Requires parentSessionKey. Omitted creations persist depth 0 so
   * operator sessions and forks stay spawn-capable roots.
   */
  spawnDepth?: number;
  /** Trusted effective policy captured by an in-process visible spawn. */
  spawnToolPolicy?: {
    version: 1;
    completionOwnerSessionKey?: string;
    allow: string[];
    deny: string[];
  };
  spawnedCwd?: string;
  /** Prepares session-owned resources while the target lifecycle fence is held. */
  prepareLifecycle?: PrepareGatewaySessionLifecycle;
  onLifecycleCleanupError?: (error: unknown) => void;
  /** Bind session exec to host=node with this node id; caller scope-checks. */
  execNode?: string;
  /** Working directory interpreted only by execNode. */
  execCwd?: string;
  /** Clear a prior node binding when a new Gateway-host session replaces it. */
  clearExecBinding?: boolean;
  clearSpawnedCwd?: boolean;
  fork?: boolean;
  forkFrom?: "last-completed";
  /**
   * Controls whether a distinct child terminates its parent. Omission preserves
   * the legacy rollover; callers use `false` for a parallel child.
   */
  succeedsParent?: boolean;
  emitCommandHooks?: boolean;
  resetMainWhenUnspecified?: boolean;
  commandSource: string;
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
  /** Trusted in-process initializer; never populated from public Gateway params. */
  initialEntry?: TrustedInitialSessionEntry;
  /** Public callers need admin before reconfiguring an adopted keyed session. */
  allowExistingModelSelection?: boolean;
  /** Admitted operator scopes; omitted only by trusted in-process callers. */
  requestingOperatorScopes?: readonly string[];
  /** Trusted in-process creation provenance; never populated from public Gateway params. */
  creation?: { via: SessionCreatedVia; actor?: SessionCreatedActor };
  /** Exact harness namespace authorized by the scoped plugin runtime. */
  authorizedAgentHarnessId?: string;
  /** Exact plugin namespace authorized by the scoped plugin runtime. */
  authorizedPluginId?: string;
  afterCreate?: (created: CreatedGatewaySession) => Promise<void>;
  /** Synchronous caller-authority guard checked by each durable owner boundary. */
  commitGuard?: () => void;
}): Promise<CreateGatewaySessionResult> {
  const requestedKey = normalizeOptionalString(params.key);
  const parentSessionKey = normalizeOptionalString(params.parentSessionKey);
  const projectId = normalizeOptionalString(params.projectId);
  const explicitAgentId = normalizeOptionalString(params.agentId);
  const explicitKeyAgentId = parseAgentSessionKey(requestedKey)?.agentId;
  if (
    explicitAgentId &&
    explicitKeyAgentId &&
    normalizeAgentId(explicitKeyAgentId) !== normalizeAgentId(explicitAgentId)
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `sessions.create key agent (${explicitKeyAgentId}) does not match agentId (${normalizeAgentId(explicitAgentId)})`,
      ),
    };
  }
  const requestedKeyAgent = requestedKey
    ? resolveRequestedSessionAgentId(params.cfg, requestedKey, explicitAgentId, {
        allowUnconfiguredExplicitAgent: true,
      })
    : undefined;
  if (requestedKeyAgent && !requestedKeyAgent.ok) {
    return requestedKeyAgent;
  }
  // Resolve the main alias under an explicit selection before compatibility ownership.
  const implicitSelectionKey = explicitAgentId
    ? `agent:${normalizeAgentId(explicitAgentId)}:main`
    : "main";
  const implicitAgent = requestedKeyAgent
    ? undefined
    : resolveRequestedSessionAgentId(params.cfg, implicitSelectionKey, explicitAgentId, {
        allowUnconfiguredExplicitAgent: true,
      });
  if (implicitAgent && !implicitAgent.ok) {
    return implicitAgent;
  }
  const agentId = normalizeAgentId(
    explicitAgentId ?? requestedKeyAgent?.agentId ?? implicitAgent?.agentId,
  );
  const catalogModel = normalizeOptionalString(params.catalogTarget?.model);
  const catalogAgentRuntime = normalizeOptionalAgentRuntimeId(params.catalogTarget?.agentRuntime);
  const catalogPluginOwnerId = normalizeOptionalString(params.catalogTarget?.pluginOwnerId);
  if (params.catalogTarget && (!catalogModel || !catalogAgentRuntime || !catalogPluginOwnerId)) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "invalid catalog session target"),
    };
  }
  if (params.succeedsParent !== undefined) {
    if (!parentSessionKey) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "succeedsParent requires parentSessionKey"),
      };
    }
    if (params.emitCommandHooks !== true) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "succeedsParent requires emitCommandHooks"),
      };
    }
    if (params.succeedsParent && params.fork === true) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "succeedsParent conflicts with fork: a fork runs in parallel to its parent",
        ),
      };
    }
  }
  const loweredRequestedKey = normalizeOptionalLowercaseString(requestedKey);
  const explicitTargetKey = requestedKey
    ? loweredRequestedKey === "global" || loweredRequestedKey === "unknown"
      ? loweredRequestedKey
      : toAgentStoreSessionKey({
          agentId,
          requestKey: requestedKey,
          mainKey: params.cfg.session?.mainKey,
        })
    : undefined;
  const explicitTargetParts = parseAgentSessionKey(explicitTargetKey);
  const explicitIncognito = isIncognitoSessionKey(explicitTargetKey);
  const explicitDashboardIncognito =
    explicitIncognito &&
    explicitTargetParts?.agentId === agentId &&
    explicitTargetParts.rest.startsWith("dashboard:");
  if (explicitIncognito && params.incognito !== true) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "incognito-shaped session keys require incognito: true",
      ),
    };
  }
  if (params.incognito === true && explicitTargetKey) {
    if (!explicitDashboardIncognito) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "incognito sessions are web-only"),
      };
    }
    const durableStorePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
    const durableEntryExists = listSessionEntriesReadOnly({
      agentId,
      storePath: durableStorePath,
    }).some(({ sessionKey }) => sessionKey === explicitTargetKey);
    if (durableEntryExists || loadGatewaySessionEntryReadOnly(explicitTargetKey).entry) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "incognito is immutable and requires a new session key",
        ),
      };
    }
  }
  if (
    params.catalogTarget &&
    explicitTargetKey &&
    !explicitTargetKey.startsWith(`agent:${agentId}:dashboard:`)
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "catalog sessions require a generated dashboard key",
      ),
    };
  }

  const authorizedHarnessCreation = Boolean(
    explicitTargetKey &&
    params.initialEntry &&
    normalizeOptionalAgentRuntimeId(params.authorizedAgentHarnessId) ===
      normalizeOptionalAgentRuntimeId(params.initialEntry.agentHarnessId) &&
    isAgentHarnessSessionKeyOwnedBy(explicitTargetKey, params.authorizedAgentHarnessId),
  );
  const authorizedPluginCreation = Boolean(
    explicitTargetKey &&
    params.initialEntry?.pluginOwnerId &&
    params.authorizedPluginId === params.initialEntry.pluginOwnerId,
  );
  if (params.initialEntry?.pluginOwnerId && !authorizedPluginCreation) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "trusted plugin session owner is not authorized",
      ),
    };
  }
  const existingHarnessEntry =
    explicitTargetKey && isAgentHarnessSessionKey(explicitTargetKey)
      ? resolveSessionEntryAccessTarget({ cfg: params.cfg, sessionKey: explicitTargetKey }).entry
      : undefined;
  if (
    explicitTargetKey &&
    isAgentHarnessSessionKey(explicitTargetKey) &&
    !authorizedHarnessCreation &&
    (!existingHarnessEntry || existingHarnessEntry.modelSelectionLocked === true)
  ) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE),
    };
  }

  if (params.fork === true && !parentSessionKey) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "fork requires parentSessionKey"),
    };
  }
  if (params.forkFrom && params.fork !== true) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "forkFrom requires fork=true"),
    };
  }
  if (params.spawnDepth !== undefined) {
    if (!Number.isInteger(params.spawnDepth) || params.spawnDepth < 1) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "spawnDepth must be an integer >= 1"),
      };
    }
    if (!parentSessionKey) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "spawnDepth requires parentSessionKey"),
      };
    }
  }
  if (params.spawnToolPolicy && params.spawnDepth === undefined) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "spawn tool policy requires spawnDepth"),
    };
  }
  let canonicalParentSessionKey: string | undefined;
  let parentSessionEntry: SessionEntry | undefined;
  let parentSelectedAgentId: string | undefined;
  let parentSessionTarget: ReturnType<typeof resolveGatewaySessionStoreTarget> | undefined;
  if (parentSessionKey) {
    const parentRequestedAgent = resolveRequestedSessionAgentId(
      params.cfg,
      parentSessionKey,
      !parseAgentSessionKey(parentSessionKey) &&
        ["global", "unknown"].includes(parentSessionKey.toLowerCase())
        ? explicitAgentId
        : undefined,
    );
    if (!parentRequestedAgent.ok) {
      return parentRequestedAgent;
    }
    parentSelectedAgentId = parentRequestedAgent.agentId;
    const parent = loadGatewaySessionEntryReadOnly(parentSessionKey, {
      agentId: parentSelectedAgentId,
    });
    if (!parent.entry?.sessionId) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unknown parent session: ${parentSessionKey}`,
        ),
      };
    }
    const parentOwnershipError = resolvePluginSessionOwnershipError({
      action: params.fork === true ? "fork" : "link",
      entry: parent.entry,
      key: parent.canonicalKey,
      pluginOwnerId: params.authorizedPluginId,
    });
    if (parentOwnershipError) {
      return { ok: false, error: parentOwnershipError };
    }
    if (isModelSelectionLocked(parent.entry)) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE),
      };
    }
    canonicalParentSessionKey = parent.canonicalKey;
    parentSessionEntry = parent.entry;
    parentSessionTarget = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: parentSessionKey,
      ...(parentSelectedAgentId ? { agentId: parentSelectedAgentId } : {}),
    });
  }
  const parentIncognito =
    parentSessionEntry?.incognito === true || isIncognitoSessionKey(canonicalParentSessionKey);
  const incognito = params.incognito === true || parentIncognito;
  if (
    incognito &&
    params.requestingOperatorScopes !== undefined &&
    !params.requestingOperatorScopes.includes(ADMIN_SCOPE)
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `incognito sessions require gateway scope: ${ADMIN_SCOPE}`,
      ),
    };
  }
  if (incognito && canonicalParentSessionKey && !parentIncognito) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "incognito sessions cannot have durable parents",
      ),
    };
  }
  if (parentIncognito && explicitTargetKey) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "incognito sessions are web-only"),
    };
  }

  if (
    canonicalParentSessionKey &&
    explicitTargetKey &&
    resolveGatewaySessionStoreTarget({ cfg: params.cfg, key: explicitTargetKey, agentId })
      .canonicalKey === canonicalParentSessionKey
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "sessions.create key must differ from parentSessionKey",
      ),
    };
  }

  const targetSessionKey = explicitTargetKey ?? buildDashboardSessionKey(agentId, { incognito });
  const creationTarget = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: targetSessionKey,
    agentId,
  });
  if (explicitTargetKey && !params.initialEntry) {
    // A trusted initializer holds the lifecycle fence through afterCreate. Waiting
    // on that fence would deadlock callers that must reject its visible pending row.
    const pendingEntry = resolveSessionEntryAccessTarget({
      cfg: params.cfg,
      sessionKey: creationTarget.canonicalKey,
    }).entry;
    if (pendingEntry?.initializationPending === true) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Session ${creationTarget.canonicalKey} is still initializing; retry creation later.`,
        ),
      };
    }
  }
  const agentMainSessionKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId });
  // Durable dashboard sessions parent to main for flow-up notices and sidebar threads.
  // Incognito roots omit durable lineage so notices cannot cross the storage boundary.
  const dashboardParentSessionKey =
    !parentSessionKey &&
    !params.authorizedPluginId &&
    !incognito &&
    params.fork !== true &&
    (params.cfg.session?.dmScope ?? "main") === "main" &&
    params.cfg.session?.scope !== "global" &&
    targetSessionKey !== agentMainSessionKey
      ? agentMainSessionKey
      : undefined;

  if (
    canonicalParentSessionKey &&
    params.fork !== true &&
    params.emitCommandHooks === true &&
    !requestedKey &&
    params.resetMainWhenUnspecified === true &&
    !parentIncognito &&
    // Catalog targets need a fresh locked row; resetting main would return before
    // the catalog-owned model/runtime pair is persisted.
    !params.catalogTarget &&
    params.cfg.session?.dmScope === "main"
  ) {
    const parentAgentId = normalizeAgentId(
      parentSelectedAgentId ?? resolveAgentIdFromSessionKey(canonicalParentSessionKey) ?? agentId,
    );
    const parentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: parentAgentId });
    if (canonicalParentSessionKey === parentMainKey) {
      if (params.visibility) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            "sessions.create visibility requires a new session",
          ),
        };
      }
      const { performGatewaySessionReset } = await loadSessionLifecycleRuntime();
      const spawnedCwd = normalizeOptionalString(params.spawnedCwd);
      const execCwd = normalizeOptionalString(params.execCwd);
      const resetResult = await performGatewaySessionReset({
        key: canonicalParentSessionKey,
        ...(parentSelectedAgentId ? { agentId: parentSelectedAgentId } : {}),
        reason: "new",
        commandSource: params.commandSource,
        ...(params.creation ? { creation: params.creation } : {}),
        ...(spawnedCwd ? { spawnedCwd } : {}),
        ...(params.prepareLifecycle ? { prepareLifecycle: params.prepareLifecycle } : {}),
        ...(params.onLifecycleCleanupError
          ? { onLifecycleCleanupError: params.onLifecycleCleanupError }
          : {}),
        ...(params.execNode ? { execNode: params.execNode } : {}),
        ...(execCwd ? { execCwd } : {}),
        ...(params.clearExecBinding ? { clearExecBinding: true } : {}),
        ...(params.clearSpawnedCwd && !spawnedCwd ? { clearSpawnedCwd: true } : {}),
        ...(params.commitGuard ? { assertAuthorizedInstance: params.commitGuard } : {}),
      });
      if (!resetResult.ok) {
        return resetResult;
      }
      if ("incognitoDeleted" in resetResult) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, "incognito sessions cannot reset in place"),
        };
      }
      return {
        ok: true,
        key: resetResult.key,
        agentId: resetResult.agentId,
        entry: resetResult.entry,
        resolved: resetResult.resolved,
        resetExisting: true,
      };
    }
  }

  let createdContext: CreatedGatewaySession | undefined;
  let createdNewEntry = false;
  let preparedLifecycle: PreparedGatewaySessionLifecycle | undefined;
  let lifecyclePreparationCommitted = false;
  const spawnToolPolicy =
    params.spawnToolPolicy && canonicalParentSessionKey
      ? {
          completionOwnerSessionKey: normalizeOptionalString(
            params.spawnToolPolicy.completionOwnerSessionKey,
          ),
          allow: normalizeInheritedToolAllowlist(params.spawnToolPolicy.allow),
          deny: normalizeInheritedToolDenylist(params.spawnToolPolicy.deny),
          parentSessionKey: canonicalParentSessionKey,
        }
      : undefined;
  const createChildSession = async (): Promise<CreateGatewaySessionResult> => {
    params.commitGuard?.();
    let currentParentSessionEntry = parentSessionEntry;
    if (
      canonicalParentSessionKey &&
      parentSessionTarget &&
      (params.emitCommandHooks === true ||
        params.fork === true ||
        params.authorizedPluginId !== undefined)
    ) {
      const currentParent = loadGatewaySessionEntryReadOnly(
        canonicalParentSessionKey,
        parentSelectedAgentId ? { agentId: parentSelectedAgentId } : undefined,
      );
      const currentParentEntry = currentParent.entry;
      if (
        !currentParentEntry?.sessionId ||
        currentParentEntry.sessionId !== parentSessionEntry?.sessionId
      ) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Parent session ${parentSessionKey} changed before ${params.fork === true ? "fork" : "/new"}; retry.`,
          ),
        };
      }
      currentParentSessionEntry = currentParentEntry;
      const parentOwnershipError = resolvePluginSessionOwnershipError({
        action: params.fork === true ? "fork" : "link",
        entry: currentParentEntry,
        key: canonicalParentSessionKey,
        pluginOwnerId: params.authorizedPluginId,
      });
      if (parentOwnershipError) {
        return { ok: false, error: parentOwnershipError };
      }
      if (
        (params.emitCommandHooks === true || params.fork === true) &&
        isModelSelectionLocked(currentParentEntry)
      ) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE),
        };
      }
      const parentHasActiveWork =
        (params.emitCommandHooks === true || params.fork === true) &&
        (isEmbeddedAgentRunActive(currentParentEntry.sessionId) ||
          isSessionWorkAdmissionActive(parentSessionTarget.storePath, [
            canonicalParentSessionKey,
            currentParentEntry.sessionId,
          ]));
      if (
        parentHasActiveWork &&
        (params.forkFrom !== "last-completed" || params.emitCommandHooks === true)
      ) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `Parent session ${parentSessionKey} is still active; try again in a moment.`,
          ),
        };
      }
    }

    if (canonicalParentSessionKey && parentSessionTarget && params.emitCommandHooks === true) {
      const parentEntry = currentParentSessionEntry;
      const parentAgentId = normalizeAgentId(
        parentSelectedAgentId ?? resolveAgentIdFromSessionKey(canonicalParentSessionKey) ?? agentId,
      );
      const workspaceDir = resolveAgentWorkspaceDir(params.cfg, parentAgentId);
      if (hasInternalHookListeners("command", "new")) {
        await triggerInternalHook(
          createInternalHookEvent("command", "new", canonicalParentSessionKey, {
            agentId: parentAgentId,
            sessionEntry: parentEntry,
            previousSessionEntry: parentEntry,
            commandSource: params.commandSource,
            cfg: params.cfg,
            storePath: parentSessionTarget.storePath,
            workspaceDir,
          }),
        );
      }
      const { emitGatewayBeforeResetPluginHook } = await loadSessionLifecycleRuntime();
      await emitGatewayBeforeResetPluginHook({
        cfg: params.cfg,
        key: canonicalParentSessionKey,
        target: parentSessionTarget,
        storePath: parentSessionTarget.storePath,
        entry: parentEntry,
        reason: "new",
      });
    }

    const target = creationTarget;
    const currentTargetEntry = loadGatewaySessionEntryReadOnly(target.canonicalKey, {
      agentId: target.agentId,
    }).entry;
    const titleModelSelection = resolveSessionCreateModelSelection(
      params.cfg,
      target.agentId,
      params.catalogTarget ?? params.model,
      currentParentSessionEntry,
    );
    const preparationResult = params.prepareLifecycle
      ? await params.prepareLifecycle({
          agentId: target.agentId,
          entry: currentTargetEntry,
          key: target.canonicalKey,
          storePath: target.storePath,
          titleModelSelection,
        })
      : undefined;
    if (preparationResult && !preparationResult.ok) {
      return { ok: false, error: preparationResult.error };
    }
    preparedLifecycle = preparationResult?.value;

    const created = await createSessionEntryWithTranscript<ErrorShape>(
      {
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
      },
      async ({ existingEntry, sessionEntries }) => {
        // This callback owns generated and explicit keys alike; no existing row
        // is the canonical signal that this request will actually create one.
        const existingOwnershipError = resolvePluginSessionOwnershipError({
          action: "adopt",
          entry: existingEntry,
          key: target.canonicalKey,
          pluginOwnerId: params.authorizedPluginId,
        });
        if (existingOwnershipError) {
          return { ok: false, error: existingOwnershipError };
        }
        if (
          isAgentHarnessSessionKey(target.canonicalKey) &&
          !authorizedHarnessCreation &&
          (!existingEntry || existingEntry.modelSelectionLocked === true)
        ) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
            ),
          };
        }
        if (!params.initialEntry && existingEntry?.initializationPending === true) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.UNAVAILABLE,
              `Session ${target.canonicalKey} is still initializing; retry creation later.`,
            ),
          };
        }
        if (params.initialEntry && existingEntry !== undefined) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "trusted initial session state requires a new session",
            ),
          };
        }
        if (params.catalogTarget && existingEntry !== undefined) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "catalog session target requires a new session",
            ),
          };
        }
        if (spawnToolPolicy && existingEntry !== undefined) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "spawn tool policy requires a new session",
            ),
          };
        }
        if (
          params.visibility &&
          existingEntry === undefined &&
          !isSessionVisibilityAllowed(params.cfg, params.visibility)
        ) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `session visibility is disabled: ${params.visibility}`,
              { details: { code: "SESSION_VISIBILITY_DISABLED", visibility: params.visibility } },
            ),
          };
        }
        if (
          params.visibility &&
          existingEntry !== undefined &&
          resolveSessionVisibility(existingEntry) !== params.visibility
        ) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "sessions.create visibility requires a new session",
            ),
          };
        }
        // Adoption of an existing key must not stamp provenance or emit a
        // `created` event; only a genuinely new row is a node creation.
        createdNewEntry = existingEntry === undefined;
        const requestedModel = normalizeOptionalString(params.model);
        const requestedThinkingLevel = normalizeOptionalString(params.thinkingLevel);
        if (existingEntry?.sessionId && params.allowExistingModelSelection !== true) {
          const gateDefaultModel = resolveDefaultModelForAgent({
            cfg: params.cfg,
            agentId: target.agentId,
          });
          const modelSelectionWouldChange = await existingModelSelectionWouldChange({
            agentId: target.agentId,
            cfg: params.cfg,
            catalogModel,
            defaultModel: gateDefaultModel.model,
            defaultProvider: gateDefaultModel.provider,
            existingEntry,
            loadGatewayModelCatalog: params.loadGatewayModelCatalog,
            requestedModel,
            requestedThinkingLevel,
            subagentModelHint: isSubagentSessionKey(target.canonicalKey)
              ? resolveSubagentConfiguredModelSelection({
                  cfg: params.cfg,
                  agentId: target.agentId,
                })
              : undefined,
          });
          if (modelSelectionWouldChange) {
            return {
              ok: false,
              error: missingScopeErrorShape({
                missingScope: ADMIN_SCOPE,
                requiredScopes: [ADMIN_SCOPE],
              }),
            };
          }
        }
        const patched = await projectSessionsPatchEntry({
          cfg: params.cfg,
          existingEntry: sessionEntries[target.canonicalKey],
          isLabelInUse: (label) =>
            Object.entries(sessionEntries).some(
              ([sessionKey, entry]) => sessionKey !== target.canonicalKey && entry.label === label,
            ),
          storeKey: target.canonicalKey,
          agentId: target.agentId,
          patch: {
            key: target.canonicalKey,
            label: normalizeOptionalString(params.label),
            category: normalizeOptionalString(params.category),
            model: catalogModel ?? requestedModel,
            thinkingLevel: requestedThinkingLevel,
          },
          loadGatewayModelCatalog: params.loadGatewayModelCatalog,
          authorizedAgentHarnessId: params.authorizedAgentHarnessId,
        });
        if (!patched.ok) {
          return patched;
        }
        sessionEntries[target.canonicalKey] = patched.entry;
        const spawnedCwd = normalizeOptionalString(
          preparedLifecycle?.spawnedCwd ?? params.spawnedCwd,
        );
        const execNode = normalizeOptionalString(params.execNode);
        const execCwd = normalizeOptionalString(params.execCwd);
        const initialAgentHarnessId = params.initialEntry
          ? normalizeOptionalString(params.initialEntry.agentHarnessId)
          : undefined;
        if (params.initialEntry && !initialAgentHarnessId && !authorizedPluginCreation) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              params.initialEntry?.agentHarnessId !== undefined
                ? "initial agentHarnessId must be non-empty"
                : "trusted initial session state requires an authorized owner",
            ),
          };
        }
        if (
          params.initialEntry?.modelSelectionLocked !== undefined &&
          !params.initialEntry.modelSelectionLocked
        ) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "initial modelSelectionLocked must be true when provided",
            ),
          };
        }
        const catalogResolvedModel = params.catalogTarget
          ? resolveSessionModelRef(params.cfg, patched.entry, target.agentId)
          : undefined;
        const initializedEntry: SessionEntry = {
          ...patched.entry,
          // New rows must expose the same canonical delivery shape to callbacks
          // that the SQLite writer persists, or guarded finalization sees its own write as drift.
          ...(existingEntry === undefined && patched.entry.delivery === undefined
            ? { delivery: normalizeSessionDeliveryState() }
            : {}),
          // Stamp provenance only for genuinely new rows: adopting an existing key
          // must not restamp write-once node facts (this direct store write bypasses
          // the merge-level write-once guard), and legacy rows stay "unknown".
          ...(params.creation && createdNewEntry ? buildSessionCreationStamp(params.creation) : {}),
          ...(params.visibility && createdNewEntry ? { visibility: params.visibility } : {}),
          ...(projectId && createdNewEntry ? { projectId } : {}),
          ...(catalogResolvedModel && catalogAgentRuntime
            ? {
                providerOverride: catalogResolvedModel.provider,
                modelOverride: catalogResolvedModel.model,
                modelOverrideSource: "user" as const,
                modelOverrideRouteResolution: "resolved" as const,
                agentRuntimeOverride: catalogAgentRuntime,
                modelSelectionLocked: true,
                pluginOwnerId: catalogPluginOwnerId,
              }
            : {}),
          // Session worktrees adopt cwd only during admin-gated creation; public patching stays
          // restricted to spawned subagent and ACP lineage.
          ...(spawnedCwd ? { spawnedCwd } : {}),
          ...(preparedLifecycle?.worktree ? { worktree: preparedLifecycle.worktree } : {}),
          ...(execNode ? { execHost: "node", execNode, ...(execCwd ? { execCwd } : {}) } : {}),
          ...(initialAgentHarnessId ? { agentHarnessId: initialAgentHarnessId } : {}),
          ...(createdNewEntry && params.authorizedPluginId && !params.catalogTarget
            ? { pluginOwnerId: params.authorizedPluginId }
            : {}),
          ...(authorizedPluginCreation && params.initialEntry?.providerOverride
            ? { providerOverride: params.initialEntry.providerOverride }
            : {}),
          ...(authorizedPluginCreation && params.initialEntry?.modelOverride
            ? { modelOverride: params.initialEntry.modelOverride }
            : {}),
          ...(authorizedPluginCreation && params.initialEntry?.modelOverrideRouteResolution
            ? { modelOverrideRouteResolution: params.initialEntry.modelOverrideRouteResolution }
            : {}),
          // Seeded CLI bindings ride only the plugin-authorized creation path;
          // harness creations must never smuggle pre-bound CLI session ids.
          ...(authorizedPluginCreation && params.initialEntry?.cliSessionBindings
            ? { cliSessionBindings: structuredClone(params.initialEntry.cliSessionBindings) }
            : {}),
          ...(params.initialEntry?.initializationPending === true
            ? { initializationPending: true }
            : {}),
          ...(params.initialEntry?.modelSelectionLocked === true
            ? { modelSelectionLocked: true }
            : {}),
          ...(params.initialEntry?.pluginExtensions !== undefined
            ? { pluginExtensions: structuredClone(params.initialEntry.pluginExtensions) }
            : {}),
          // Spawn lineage is declared, never inferred: spawn-owned creations pass
          // spawnDepth explicitly; everything else (operator chats, forks, harness
          // and plugin sessions) persists as a depth-0 root. Reused entries keep
          // their stored depth.
          ...(existingEntry === undefined ? { spawnDepth: params.spawnDepth ?? 0 } : {}),
          ...(existingEntry === undefined && spawnToolPolicy
            ? {
                spawnedBy: spawnToolPolicy.parentSessionKey,
                ...(spawnToolPolicy.completionOwnerSessionKey
                  ? { completionOwnerSessionKey: spawnToolPolicy.completionOwnerSessionKey }
                  : {}),
                inheritedToolPolicyVersion: 1 as const,
                ...(spawnToolPolicy.allow.length > 0
                  ? { inheritedToolAllow: spawnToolPolicy.allow }
                  : {}),
                ...(spawnToolPolicy.deny.length > 0
                  ? { inheritedToolDeny: spawnToolPolicy.deny }
                  : {}),
              }
            : {}),
          ...(existingEntry === undefined && incognito ? { incognito: true as const } : {}),
        };
        sessionEntries[target.canonicalKey] = initializedEntry;
        const initialized = { ...patched, entry: initializedEntry };
        const explicitParentSessionKey =
          canonicalParentSessionKey ?? normalizeOptionalString(initializedEntry.parentSessionKey);
        const storedParentSessionKey = explicitParentSessionKey ?? dashboardParentSessionKey;
        if (!storedParentSessionKey) {
          return initialized;
        }
        const inheritedSelection =
          !canonicalParentSessionKey || catalogModel || normalizeOptionalString(params.model)
            ? {}
            : inheritSessionSelection(currentParentSessionEntry);
        const entry: SessionEntry = {
          ...initializedEntry,
          ...inheritedSelection,
          parentSessionKey: storedParentSessionKey,
          ...(canonicalParentSessionKey && currentParentSessionEntry?.sessionId
            ? { parentSessionId: currentParentSessionEntry.sessionId }
            : {}),
        };
        if (params.fork !== true) {
          return { ...initialized, entry };
        }
        const forkParentSessionKey = canonicalParentSessionKey;
        if (!forkParentSessionKey || !currentParentSessionEntry || !parentSessionTarget) {
          return {
            ok: false,
            error: errorShape(ErrorCodes.UNAVAILABLE, "failed to resolve parent session for fork"),
          };
        }
        // The storage owner selects one source for both size admission and copying,
        // so an active tail cannot make a smaller stable prefix fail the cap.
        const forkResult = await forkSessionFromParentWithDecision({
          parentEntry: currentParentSessionEntry,
          agentId: parentSessionTarget.agentId,
          parentSessionKey: forkParentSessionKey,
          sessionKey: target.canonicalKey,
          storePath: parentSessionTarget.storePath,
          // Keep the fork transcript owned by the child store across agent boundaries.
          targetStorePath: target.storePath,
          ...(params.forkFrom ? { forkFrom: params.forkFrom } : {}),
        });
        if (forkResult.status === "too-large") {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `parent session is too large to fork (${forkResult.decision.parentTokens}/${forkResult.decision.maxTokens} tokens)`,
            ),
          };
        }
        if (forkResult.status !== "created") {
          return {
            ok: false,
            error: errorShape(ErrorCodes.UNAVAILABLE, "failed to fork parent session transcript"),
          };
        }
        const fork = forkResult.transcript;
        return {
          ...initialized,
          entry: buildForkedGatewaySessionEntry(
            entry,
            fork,
            {
              sessionKey: forkParentSessionKey,
              sessionId: currentParentSessionEntry.sessionId,
            },
            existingEntry,
          ),
        };
      },
      {
        ...(params.initialEntry
          ? {
              activeSessionKey: target.canonicalKey,
              requireWriteSuccess: true,
            }
          : {}),
        ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
      },
    );
    if (!created.ok) {
      return {
        ok: false,
        error:
          created.phase === "transcript"
            ? errorShape(
                ErrorCodes.UNAVAILABLE,
                `failed to create session transcript: ${created.error}`,
              )
            : created.error,
      };
    }
    createdContext = {
      key: target.canonicalKey,
      agentId: target.agentId,
      entry: created.entry,
      storePath: target.storePath,
    };
    lifecyclePreparationCommitted = true;
    if (createdNewEntry) {
      // The created fact belongs to this row generation; record it before a
      // same-key delete can acquire the lifecycle fence and purge that state.
      recordSessionCreated({
        sessionKey: createdContext.key,
        agentId: createdContext.agentId,
        entry: createdContext.entry,
      });
    }

    if (canonicalParentSessionKey && parentSessionTarget && params.emitCommandHooks === true) {
      const parentEntry = currentParentSessionEntry;
      const { emitGatewaySessionEndPluginHook, emitGatewaySessionStartPluginHook } =
        await loadSessionLifecycleRuntime();
      // Child key shape does not establish lifecycle ownership. The caller owns
      // that fact; omission keeps the shipped rollover for out-of-tree clients.
      if (params.succeedsParent !== false) {
        emitGatewaySessionEndPluginHook({
          cfg: params.cfg,
          sessionKey: canonicalParentSessionKey,
          sessionId: parentEntry?.sessionId,
          storePath: parentSessionTarget.storePath,
          sessionFile: canonicalParentSessionKey,
          agentId: parentSessionTarget.agentId,
          reason: "new",
          nextSessionId: created.entry.sessionId,
          nextSessionKey: target.canonicalKey,
        });
      }
      emitGatewaySessionStartPluginHook({
        cfg: params.cfg,
        sessionKey: target.canonicalKey,
        sessionId: created.entry.sessionId,
        resumedFrom: parentEntry?.sessionId,
        storePath: target.storePath,
        sessionFile: target.canonicalKey,
        agentId: target.agentId,
      });
    }

    const selectedModel = resolveSessionModelRef(params.cfg, created.entry, target.agentId);

    return {
      ok: true,
      key: target.canonicalKey,
      agentId: target.agentId,
      entry: created.entry,
      resolved: {
        modelProvider: selectedModel.provider,
        model: selectedModel.model,
      },
      resetExisting: false,
    };
  };

  const lifecycleTargets = [
    {
      scope: creationTarget.storePath,
      identities: [creationTarget.canonicalKey],
    },
  ];
  if (
    canonicalParentSessionKey &&
    parentSessionEntry?.sessionId &&
    parentSessionTarget &&
    (params.emitCommandHooks === true ||
      params.fork === true ||
      params.authorizedPluginId !== undefined)
  ) {
    lifecycleTargets.push({
      scope: parentSessionTarget.storePath,
      identities: [canonicalParentSessionKey, parentSessionEntry.sessionId],
    });
  }
  // Generated, keyed, same-store, and cross-agent creations all share the
  // lifecycle owner's canonical identity order and one active mutation fence.
  const result = await runExclusiveSessionLifecycleMutation({
    targets: lifecycleTargets,
    run: createChildSession,
    finalize: async () => {
      if (!lifecyclePreparationCommitted) {
        await rollbackGatewaySessionPreparation({
          prepared: preparedLifecycle,
          onError: params.onLifecycleCleanupError,
        });
      }
    },
  });
  if (result.ok && !result.resetExisting && createdContext) {
    await params.afterCreate?.(createdContext);
  }
  return result;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
