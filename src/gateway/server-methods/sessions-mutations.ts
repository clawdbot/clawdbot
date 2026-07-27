// Session metadata mutations, plugin state, and reset routing.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsPatchParams,
  validateSessionsPluginPatchParams,
  validateSessionsResetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import {
  applySessionPatchProjection,
  type SessionPatchProjectionSnapshot,
} from "../../config/sessions/session-accessor.js";
import { disableCronJobsBoundToSession } from "../../cron/job-session-bindings.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { patchPluginSessionExtension } from "../../plugins/host-hook-state.js";
import { isPluginJsonValue } from "../../plugins/host-hooks.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import {
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-create-service.js";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { triggerSessionPatchHook } from "../session-patch-hooks.js";
import {
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  resolveGatewaySessionThinkingProjection,
  resolveSessionDisplayModelIdentityRef,
  resolveSessionModelRef,
  type SessionsPatchResult,
} from "../session-utils.js";
import { projectSessionsPatchEntry } from "../sessions-patch.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { hasVisibleActiveSessionRun } from "./session-active-runs.js";
import { appendSessionAudit } from "./session-audit.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import {
  isAgentMainSessionKey,
  loadSessionsRuntimeModule,
  requireSessionKey,
  resolveGatewaySessionTargetFromKey,
  resolveSessionWorkerPlacementPatchError,
  sessionLog,
} from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionMutationHandlers: GatewayRequestHandlers = {
  "sessions.patch": async ({ params, respond, context, client, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const archiveActor = gatewayClientSessionCreator(client);
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const { target, storePath } = resolveGatewaySessionTargetFromKey(key, cfg, {
      agentId: requestedAgentId,
    });
    const canonicalKey = target.canonicalKey ?? key;
    const lifecycleEntry = loadSessionEntry(key, { agentId: requestedAgentId }).entry;
    const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
      canonicalKey,
      lifecycleEntry,
    );
    if (missingHarnessSessionError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError));
      return;
    }
    const initialPlacementPatchError = resolveSessionWorkerPlacementPatchError({
      agentId: target.agentId,
      cfg,
      context,
      entry: lifecycleEntry,
      key,
      patch: p,
      sessionKey: canonicalKey,
      validateModelRuntime: false,
    });
    if (initialPlacementPatchError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, initialPlacementPatchError));
      return;
    }
    const lifecycleIdentities = [canonicalKey, key, lifecycleEntry?.sessionId];
    if (p.archived === true && isSessionLifecycleMutationActive(storePath, lifecycleIdentities)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Cannot archive a session with an active run."),
      );
      return;
    }
    let patchModelCatalog: Awaited<ReturnType<typeof context.loadGatewayModelCatalog>> | undefined;
    const loadPatchModelCatalog = async () => {
      const catalog = await context.loadGatewayModelCatalog();
      patchModelCatalog = catalog;
      return catalog;
    };
    let wasArchivedBeforePatch = false;
    const resolvePatchTarget = ({ entries }: SessionPatchProjectionSnapshot) => {
      const store = Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
      const { target: migratedTarget, primaryKey } = migrateAndPruneGatewaySessionStoreKey({
        cfg,
        key,
        store,
        agentId: requestedAgentId,
      });
      return { primaryKey, candidateKeys: migratedTarget.storeKeys };
    };
    const applyPatch = async () => {
      const currentLifecycleEntry = loadSessionEntry(key, { agentId: requestedAgentId }).entry;
      // A reset queued ahead of archive can rotate the row before this mutation starts.
      // Never apply stale destructive intent to the replacement session identity.
      const lifecycleEntryRemoved =
        lifecycleEntry !== undefined && currentLifecycleEntry === undefined;
      const archiveTargetChanged =
        p.archived === true &&
        (lifecycleEntry === undefined
          ? currentLifecycleEntry !== undefined
          : currentLifecycleEntry !== undefined &&
            (currentLifecycleEntry.sessionId !== lifecycleEntry.sessionId ||
              currentLifecycleEntry.lifecycleRevision !== lifecycleEntry.lifecycleRevision));
      if (lifecycleEntryRemoved || archiveTargetChanged) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Session ${key} changed before patch. Retry.`),
        );
        return null;
      }
      if (p.archived === true) {
        if (canonicalKey === "global" || isAgentMainSessionKey(cfg, canonicalKey)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "Cannot archive an agent's main session."),
          );
          return null;
        }
        const { entry } = loadSessionEntry(key, { agentId: requestedAgentId });
        const activeIdentities = [canonicalKey, key, entry?.sessionId];
        if (
          isSessionWorkAdmissionActive(storePath, activeIdentities) ||
          replyRunRegistry.isActive(canonicalKey) ||
          replyRunRegistry.isActive(key) ||
          hasVisibleActiveSessionRun({
            context,
            requestedKey: key,
            canonicalKey,
            sessionId: entry?.sessionId,
            defaultAgentId: resolveDefaultAgentId(cfg),
          })
        ) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "Cannot archive a session with an active run."),
          );
          return null;
        }
      }
      return await applySessionPatchProjection({
        agentId: target.agentId,
        assertCurrent: sessionMutationAuthorization?.assertCurrent,
        storePath,
        resolveTarget: resolvePatchTarget,
        project: async ({ primaryKey, existingEntry, entries }) => {
          wasArchivedBeforePatch = existingEntry?.archivedAt !== undefined;
          const projected = await projectSessionsPatchEntry({
            cfg,
            entries,
            existingEntry,
            storeKey: primaryKey,
            agentId: requestedAgentId,
            patch: p,
            archivedBy: archiveActor,
            loadGatewayModelCatalog: loadPatchModelCatalog,
          });
          if (!projected.ok) {
            return projected;
          }
          const placementPatchError = resolveSessionWorkerPlacementPatchError({
            agentId: target.agentId,
            cfg,
            context,
            entry: projected.entry,
            key,
            patch: p,
            sessionKey: canonicalKey,
            validateModelRuntime: true,
          });
          return placementPatchError
            ? {
                ok: false,
                error: errorShape(ErrorCodes.INVALID_REQUEST, placementPatchError),
              }
            : projected;
        },
      });
    };
    const applied = await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: lifecycleIdentities,
      run: async () => {
        const result = await applyPatch();
        if (!result?.ok) {
          return result;
        }
        const archiveStateChanged =
          typeof p.archived === "boolean" &&
          wasArchivedBeforePatch !== (result.entry.archivedAt !== undefined);
        if (!archiveStateChanged || !archiveActor) {
          return result;
        }
        const action = result.entry.archivedAt === undefined ? "unarchived" : "archived";
        try {
          await appendSessionAudit({
            cfg,
            target: { agentId: target.agentId, entry: result.entry, storePath },
            text: `${action} by ${archiveActor.label ?? archiveActor.id}`,
            now: Date.now(),
          });
        } catch (error) {
          // The "<name> archived/unarchived this" system note is best-effort. The archive
          // state (archivedAt/archivedBy) is the durable outcome and is already committed; if
          // the note append fails (rare) keep the archive and log rather than reversing it.
          // Reversing raced concurrent membership/pin changes and is not worth the complexity
          // for this non-security lifecycle toggle — visibility changes, a real access
          // boundary, still roll back on audit failure.
          sessionLog.warn(
            `sessions.patch: ${action} audit note failed for ${canonicalKey}; archive kept: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        return result;
      },
    });
    if (!applied) {
      return;
    }
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }

    triggerSessionPatchHook({
      cfg,
      sessionEntry: applied.entry,
      sessionKey: target.canonicalKey ?? key,
      patch: p,
    });

    // Cron mutations are operator.admin surface while archive is write-scoped;
    // only cascade for internal callers (client == null) or admin operators so
    // write-scoped archiving cannot flip admin-managed schedules.
    const callerScopes = client?.connect ? (client.connect.scopes ?? []) : null;
    const callerCanManageCron = callerScopes === null || callerScopes.includes(ADMIN_SCOPE);
    if (p.archived === true && callerCanManageCron) {
      // Archived sessions reject new work, so schedules bound to them would
      // only accumulate failing runs; disable them with the archive.
      try {
        const disabledJobIds = await disableCronJobsBoundToSession({
          cron: context.cron,
          cfg,
          sessionKey: target.canonicalKey ?? key,
        });
        if (disabledJobIds.length > 0) {
          sessionLog.info(
            `sessions.patch: disabled cron jobs bound to archived session ${target.canonicalKey ?? key}: ${disabledJobIds.join(", ")}`,
          );
        }
      } catch (error) {
        // Best-effort by design: archive is the primary action and must not
        // fail or roll back on cron-store errors. Any job left enabled fails
        // closed at run start because archived sessions reject new work.
        sessionLog.warn(
          `sessions.patch: failed to disable cron jobs for archived session ${target.canonicalKey ?? key}: ${formatErrorMessage(error)}`,
        );
      }
    }

    // Absorb ad-hoc categories into the gateway group catalog so ordering
    // covers every group an operator UI can observe.
    if (typeof p.category === "string" && p.category.trim()) {
      ensureSessionGroupRegistered(p.category);
    }

    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(
      target.canonicalKey === "global"
        ? target.agentId
        : (parsed?.agentId ?? resolveDefaultAgentId(cfg)),
    );
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const resolvedDisplayModel = resolveSessionDisplayModelIdentityRef({
      cfg,
      agentId,
      provider: resolved.provider,
      model: resolved.model,
    });
    const thinkingProjection = resolveGatewaySessionThinkingProjection({
      cfg,
      agentId,
      provider: resolvedDisplayModel.provider ?? resolved.provider,
      model: resolvedDisplayModel.model ?? resolved.model,
      sessionKey: target.canonicalKey ?? key,
      entry: applied.entry,
      modelCatalog: patchModelCatalog,
    });
    const resolvedThinkingMetadata =
      patchModelCatalog === undefined
        ? {}
        : {
            thinkingLevel: thinkingProjection.effectiveThinkingLevel,
            thinkingLevels: thinkingProjection.thinkingLevels,
          };
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
      resolved: {
        modelProvider: resolvedDisplayModel.provider,
        model: resolvedDisplayModel.model,
        agentRuntime: thinkingProjection.agentRuntime,
        ...resolvedThinkingMetadata,
      },
    };
    respond(true, result, undefined);
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      ...(target.canonicalKey === "global" && requestedAgentId
        ? { agentId: requestedAgentId }
        : {}),
      reason: "patch",
    });
  },
  "sessions.pluginPatch": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (
      !assertValidParams(params, validateSessionsPluginPatchParams, "sessions.pluginPatch", respond)
    ) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
    if (!scopes.includes(ADMIN_SCOPE)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `sessions.pluginPatch requires gateway scope: ${ADMIN_SCOPE}`,
        ),
      );
      return;
    }
    const pluginId = normalizeOptionalString(params.pluginId);
    const namespace = normalizeOptionalString(params.namespace);
    if (!pluginId || !namespace) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "pluginId and namespace are required"),
      );
      return;
    }
    if (params.unset === true && params.value !== undefined) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.pluginPatch cannot specify both unset and value",
        ),
      );
      return;
    }
    if (params.value !== undefined && !isPluginJsonValue(params.value)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.pluginPatch value must be JSON-compatible",
        ),
      );
      return;
    }
    const patched = await patchPluginSessionExtension({
      cfg: context.getRuntimeConfig(),
      sessionKey: key,
      pluginId,
      namespace,
      value: params.value,
      unset: params.unset === true,
      assertCurrent: sessionMutationAuthorization?.assertCurrent,
    });
    if (!patched.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, patched.error));
      return;
    }
    respond(true, { ok: true, key: patched.key, value: patched.value }, undefined);
    emitSessionsChanged(context, {
      sessionKey: patched.key,
      reason: "plugin-patch",
    });
  },
  "sessions.reset": async ({ params, respond, context, client, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const reason = p.reason === "new" ? "new" : "reset";
    const { performGatewaySessionReset } = await loadSessionsRuntimeModule();
    const result = await performGatewaySessionReset({
      key,
      ...(p.agentId ? { agentId: p.agentId } : {}),
      reason,
      commandSource: "gateway:sessions.reset",
      creation: resolveOperatorSessionCreation(client),
      assertAuthorizedInstance: sessionMutationAuthorization?.assertCurrent,
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    if ("incognitoDeleted" in result) {
      respond(true, { ok: true, key: result.key, deleted: true }, undefined);
      emitSessionsChanged(context, {
        sessionKey: result.key,
        reason,
      });
      return;
    }
    respond(
      true,
      { ok: true, key: result.key, entry: result.entry, resolved: result.resolved },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: result.key,
      ...(result.key === "global" ? { agentId: result.agentId } : {}),
      reason,
    });
  },
};
