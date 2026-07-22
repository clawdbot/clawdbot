import { randomUUID } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  type SessionCreatorIdentity,
  errorShape,
  missingScopeErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import {
  forkSessionFromParent,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
  resolveParentForkDecision,
} from "../auto-reply/reply/session-fork.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import {
  createSessionEntryWithTranscript,
  resolveSessionEntryAccessTarget,
} from "../config/sessions/session-accessor.js";
import { inheritSessionSelection } from "../config/sessions/session-entry-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createInternalHookEvent,
  hasInternalHookListeners,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import {
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
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import {
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import { buildForkedGatewaySessionEntry } from "./session-create-fork-entry.js";
import { shouldPreserveSessionAuthProfileOverride } from "./session-model-patch-origin.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";
import { loadSessionEntryReadOnly, resolveGatewaySessionStoreTarget } from "./session-utils.js";
import { applySessionsPatchToStore, resolveSessionPatchModelSelection } from "./sessions-patch.js";

type TrustedCatalogSessionTarget = {
  model: string;
  agentRuntime: string;
  pluginOwnerId: string;
};

const loadSessionLifecycleRuntime = createLazyRuntimeModule(
  () => import("./server-methods/sessions.runtime.js"),
);

type RequestedSessionAgentIdResolution =
  | { ok: true; agentId?: string }
  | { ok: false; error: ErrorShape };

async function existingModelSelectionWouldChange(params: {
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

export function resolveRequestedSessionAgentId(
  cfg: OpenClawConfig,
  key: string,
  explicitAgentId?: string,
): RequestedSessionAgentIdResolution {
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey: key });
  const parsed = parseAgentSessionKey(key);
  const requestedAgentId = normalizeOptionalString(explicitAgentId);
  if (requestedAgentId) {
    const agentId = normalizeAgentId(requestedAgentId);
    if (!listAgentIds(cfg).includes(agentId)) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${explicitAgentId}"`),
      };
    }
    if (parsed?.agentId && normalizeAgentId(parsed.agentId) !== agentId) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
      };
    }
    if (canonicalKey !== "global") {
      const keyAgentId = parsed?.agentId
        ? normalizeAgentId(parsed.agentId)
        : normalizeAgentId(resolveSessionStoreAgentId(cfg, canonicalKey));
      if (keyAgentId !== agentId) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
        };
      }
    }
    return { ok: true, agentId };
  }
  if (!parsed?.agentId) {
    return { ok: true };
  }
  const inferredAgentId = normalizeAgentId(parsed.agentId);
  if (canonicalKey === "global" && !listAgentIds(cfg).includes(inferredAgentId)) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${parsed.agentId}"`),
    };
  }
  return {
    ok: true,
    agentId: canonicalKey === "global" ? inferredAgentId : undefined,
  };
}

export function buildDashboardSessionKey(agentId: string): string {
  return `agent:${agentId}:dashboard:${randomUUID()}`;
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
  model?: string;
  thinkingLevel?: string;
  /** Trusted catalog-owned model/runtime pair, persisted and locked together. */
  catalogTarget?: TrustedCatalogSessionTarget;
  createdBy?: SessionCreatorIdentity;
  parentSessionKey?: string;
  /**
   * Spawn-lineage depth declared by spawn-owned creations (visible subagent
   * sessions). Requires parentSessionKey. Omitted creations persist depth 0 so
   * operator sessions and forks stay spawn-capable roots.
   */
  spawnDepth?: number;
  spawnedCwd?: string;
  /** Managed worktree bound to the new session; persisted alongside spawnedCwd. */
  worktree?: { id: string; branch: string; repoRoot: string };
  /** Bind session exec to host=node with this node id; caller scope-checks. */
  execNode?: string;
  /** Working directory interpreted only by execNode. */
  execCwd?: string;
  /** Clear a prior node binding when a new Gateway-host session replaces it. */
  clearExecBinding?: boolean;
  clearSpawnedCwd?: boolean;
  fork?: boolean;
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
  /** Exact harness namespace authorized by the scoped plugin runtime. */
  authorizedAgentHarnessId?: string;
  /** Exact plugin namespace authorized by the scoped plugin runtime. */
  authorizedPluginId?: string;
  afterCreate?: (created: CreatedGatewaySession) => Promise<void>;
}): Promise<CreateGatewaySessionResult> {
  const requestedKey = normalizeOptionalString(params.key);
  const parentSessionKey = normalizeOptionalString(params.parentSessionKey);
  const agentId = normalizeAgentId(
    normalizeOptionalString(params.agentId) ?? resolveDefaultAgentId(params.cfg),
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
  if (requestedKey) {
    const requestedAgentId = parseAgentSessionKey(requestedKey)?.agentId;
    if (
      requestedAgentId &&
      requestedAgentId !== agentId &&
      normalizeOptionalString(params.agentId)
    ) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `sessions.create key agent (${requestedAgentId}) does not match agentId (${agentId})`,
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
  const targetSessionKey = explicitTargetKey ?? buildDashboardSessionKey(agentId);
  const agentMainSessionKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId });
  // Dashboard sessions parent to main for flow-up notices and sidebar threads.
  // Isolated DM scopes lack the shared watcher; global scope lacks a per-agent main.
  const dashboardParentSessionKey =
    !parentSessionKey &&
    params.fork !== true &&
    (params.cfg.session?.dmScope ?? "main") === "main" &&
    params.cfg.session?.scope !== "global" &&
    targetSessionKey !== agentMainSessionKey
      ? agentMainSessionKey
      : undefined;
  let canonicalParentSessionKey: string | undefined;
  let parentSessionEntry: SessionEntry | undefined;
  let parentSelectedAgentId: string | undefined;
  let parentSessionTarget: ReturnType<typeof resolveGatewaySessionStoreTarget> | undefined;
  if (parentSessionKey) {
    const parentCanonicalKey = resolveSessionStoreKey({
      cfg: params.cfg,
      sessionKey: parentSessionKey,
    });
    if (parentCanonicalKey === "global") {
      const parentRequestedAgent = resolveRequestedSessionAgentId(
        params.cfg,
        parentSessionKey,
        params.agentId,
      );
      if (!parentRequestedAgent.ok) {
        return parentRequestedAgent;
      }
      parentSelectedAgentId = parentRequestedAgent.agentId;
    }
    const parent = loadSessionEntryReadOnly(
      parentSessionKey,
      parentSelectedAgentId ? { agentId: parentSelectedAgentId } : undefined,
    );
    if (!parent.entry?.sessionId) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unknown parent session: ${parentSessionKey}`,
        ),
      };
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
      ...(canonicalParentSessionKey === "global" && parentSelectedAgentId
        ? { agentId: parentSelectedAgentId }
        : {}),
    });
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

  if (
    canonicalParentSessionKey &&
    params.fork !== true &&
    params.emitCommandHooks === true &&
    !requestedKey &&
    params.resetMainWhenUnspecified === true &&
    // Catalog targets need a fresh locked row; resetting main would return before
    // the catalog-owned model/runtime pair is persisted.
    !params.catalogTarget &&
    params.cfg.session?.dmScope === "main"
  ) {
    const parentAgentId = normalizeAgentId(
      parentSelectedAgentId ??
        resolveAgentIdFromSessionKey(canonicalParentSessionKey) ??
        resolveDefaultAgentId(params.cfg),
    );
    const parentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: parentAgentId });
    if (canonicalParentSessionKey === parentMainKey) {
      const { performGatewaySessionReset } = await loadSessionLifecycleRuntime();
      const spawnedCwd = normalizeOptionalString(params.spawnedCwd);
      const execCwd = normalizeOptionalString(params.execCwd);
      const resetResult = await performGatewaySessionReset({
        key: canonicalParentSessionKey,
        ...(canonicalParentSessionKey === "global" && parentSelectedAgentId
          ? { agentId: parentSelectedAgentId }
          : {}),
        reason: "new",
        commandSource: params.commandSource,
        createdBy: params.createdBy,
        ...(spawnedCwd ? { spawnedCwd } : {}),
        ...(params.worktree ? { worktree: params.worktree } : {}),
        ...(params.execNode ? { execNode: params.execNode } : {}),
        ...(execCwd ? { execCwd } : {}),
        ...(params.clearExecBinding ? { clearExecBinding: true } : {}),
        ...(params.clearSpawnedCwd && !spawnedCwd ? { clearSpawnedCwd: true } : {}),
      });
      if (!resetResult.ok) {
        return resetResult;
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
  const createChildSession = async (): Promise<CreateGatewaySessionResult> => {
    let currentParentSessionEntry = parentSessionEntry;
    if (
      canonicalParentSessionKey &&
      parentSessionTarget &&
      (params.emitCommandHooks === true || params.fork === true)
    ) {
      const currentParent = loadSessionEntryReadOnly(
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
      if (isModelSelectionLocked(currentParentEntry)) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE),
        };
      }
      const parentHasActiveWork =
        isEmbeddedAgentRunActive(currentParentEntry.sessionId) ||
        isSessionWorkAdmissionActive(parentSessionTarget.storePath, [
          canonicalParentSessionKey,
          currentParentEntry.sessionId,
        ]);
      if (parentHasActiveWork) {
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
        parentSelectedAgentId ??
          resolveAgentIdFromSessionKey(canonicalParentSessionKey) ??
          resolveDefaultAgentId(params.cfg),
      );
      const workspaceDir = resolveAgentWorkspaceDir(params.cfg, parentAgentId);
      if (hasInternalHookListeners("command", "new")) {
        await triggerInternalHook(
          createInternalHookEvent("command", "new", canonicalParentSessionKey, {
            sessionEntry: parentEntry,
            previousSessionEntry: parentEntry,
            commandSource: params.commandSource,
            cfg: params.cfg,
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

    const key = targetSessionKey;
    const target = resolveGatewaySessionStoreTarget({ cfg: params.cfg, key, agentId });
    const created = await createSessionEntryWithTranscript<ErrorShape>(
      {
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
      },
      async ({ existingEntry, sessionEntries }) => {
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
        const requestedModel = normalizeOptionalString(params.model);
        const requestedThinkingLevel = normalizeOptionalString(params.thinkingLevel);
        if (existingEntry?.sessionId && params.allowExistingModelSelection !== true) {
          const gateDefaultModel = resolveDefaultModelForAgent({
            cfg: params.cfg,
            agentId: target.agentId,
          });
          const modelSelectionWouldChange = await existingModelSelectionWouldChange({
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
        const patched = await applySessionsPatchToStore({
          cfg: params.cfg,
          store: sessionEntries,
          storeKey: target.canonicalKey,
          agentId: target.agentId,
          patch: {
            key: target.canonicalKey,
            label: normalizeOptionalString(params.label),
            model: catalogModel ?? requestedModel,
            thinkingLevel: requestedThinkingLevel,
          },
          loadGatewayModelCatalog: params.loadGatewayModelCatalog,
          authorizedAgentHarnessId: params.authorizedAgentHarnessId,
        });
        if (!patched.ok) {
          return patched;
        }
        const spawnedCwd = normalizeOptionalString(params.spawnedCwd);
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
          ...(existingEntry === undefined && params.createdBy
            ? { createdBy: { ...params.createdBy } }
            : {}),
          ...(catalogResolvedModel && catalogAgentRuntime
            ? {
                providerOverride: catalogResolvedModel.provider,
                modelOverride: catalogResolvedModel.model,
                modelOverrideSource: "user" as const,
                agentRuntimeOverride: catalogAgentRuntime,
                modelSelectionLocked: true,
                pluginOwnerId: catalogPluginOwnerId,
              }
            : {}),
          // Session worktrees adopt cwd only during admin-gated creation; public patching stays
          // restricted to spawned subagent and ACP lineage.
          ...(spawnedCwd ? { spawnedCwd } : {}),
          ...(params.worktree ? { worktree: params.worktree } : {}),
          ...(execNode ? { execHost: "node", execNode, ...(execCwd ? { execCwd } : {}) } : {}),
          ...(initialAgentHarnessId ? { agentHarnessId: initialAgentHarnessId } : {}),
          ...(authorizedPluginCreation
            ? { pluginOwnerId: params.initialEntry?.pluginOwnerId }
            : {}),
          ...(authorizedPluginCreation && params.initialEntry?.providerOverride
            ? { providerOverride: params.initialEntry.providerOverride }
            : {}),
          ...(authorizedPluginCreation && params.initialEntry?.modelOverride
            ? { modelOverride: params.initialEntry.modelOverride }
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
        // Operator forks honor the same oversized-parent cap as subagent forks;
        // an explicit fork of an unusable parent fails loudly instead of
        // silently producing an empty child.
        const forkDecision = await resolveParentForkDecision({
          parentEntry: currentParentSessionEntry,
          agentId: parentSessionTarget.agentId,
          storePath: parentSessionTarget.storePath,
        });
        if (forkDecision.status === "skip") {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `parent session is too large to fork (${forkDecision.parentTokens}/${forkDecision.maxTokens} tokens)`,
            ),
          };
        }
        const fork = await forkSessionFromParent({
          parentEntry: currentParentSessionEntry,
          agentId: parentSessionTarget.agentId,
          parentSessionKey: forkParentSessionKey,
          sessionKey: target.canonicalKey,
          storePath: parentSessionTarget.storePath,
          // Keep the fork transcript owned by the child store across agent boundaries.
          targetStorePath: target.storePath,
        });
        if (!fork) {
          return {
            ok: false,
            error: errorShape(ErrorCodes.UNAVAILABLE, "failed to fork parent session transcript"),
          };
        }
        return {
          ...initialized,
          entry: buildForkedGatewaySessionEntry(entry, fork),
        };
      },
      params.initialEntry
        ? {
            activeSessionKey: target.canonicalKey,
            requireWriteSuccess: true,
          }
        : undefined,
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
          sessionFile: parentEntry?.sessionFile,
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
        sessionFile: created.entry.sessionFile,
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

  if (
    canonicalParentSessionKey &&
    parentSessionEntry?.sessionId &&
    parentSessionTarget &&
    (params.emitCommandHooks === true || params.fork === true)
  ) {
    const result = await runExclusiveSessionLifecycleMutation({
      scope: parentSessionTarget.storePath,
      identities: [canonicalParentSessionKey, parentSessionEntry.sessionId],
      run: createChildSession,
    });
    if (result.ok && !result.resetExisting && createdContext) {
      await params.afterCreate?.(createdContext);
    }
    return result;
  }
  const result = await createChildSession();
  if (result.ok && !result.resetExisting && createdContext) {
    await params.afterCreate?.(createdContext);
  }
  return result;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
