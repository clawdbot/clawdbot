/** Session self-service tool. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import type {
  SessionsAssignOwnerResult,
  SessionsPatchResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { SESSIONS_PATCH_MANY_MAX_TARGETS } from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import {
  SESSION_AGENT_ATTENTION_ICON_IDS,
  SESSION_COLOR_IDS,
  SESSION_ICON_GLYPH_IDS,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayTransportError } from "../../gateway/call.js";
import { withAgentSessionModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isTransientNetworkError } from "../../infra/unhandled-rejections.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readToolStringParam,
  ToolAuthorizationError,
  ToolInputError,
} from "./common.js";
import {
  callAgentToolGatewayRequest,
  hasInProcessGatewayToolContext,
  runWithGatewayToolCleanupContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { resolveSessionToolTargetAgentId } from "./scoped-session-access.js";
import {
  formatSessionToolAccessDenial,
  recordSessionToolActionFact,
  resolveSessionToolAccess,
  runSessionToolActionWithConflictReceipt,
} from "./sessions-access.js";
import { resolveSessionToolContext } from "./sessions-helpers.js";
import { resolveSessionReference, shouldResolveSessionIdInput } from "./sessions-resolution.js";
import {
  readSessionsToolPatch,
  runSessionsToolPatchMany,
  sessionsToolResultFitsBudget,
} from "./sessions-tool-patch.js";

const ACTIONS = [
  "patch",
  "reset",
  "delete",
  "assign_owner",
  "group_list",
  "group_set",
  "group_rename",
  "group_delete",
] as const;
const GROUP_NAME_MAX_LENGTH = 512;
const SELF_ARCHIVE_MAX_RETRY_DELAY_MS = 5_000;
const RESOLVED_OMITTED_REASON = "response_budget_exceeded";
const SESSION_ICON_GLYPH_DESCRIPTION = SESSION_ICON_GLYPH_IDS.join(", ");
const log = createSubsystemLogger("agents/sessions");

type SessionsResolved = NonNullable<SessionsPatchResult["resolved"]>;

function withBoundedSessionsResolved(
  acknowledgement: Record<string, unknown>,
  resolved: SessionsResolved | undefined,
): Record<string, unknown> {
  if (!resolved) {
    return acknowledgement;
  }
  const completeResult = { ...acknowledgement, resolved };
  if (sessionsToolResultFitsBudget(completeResult)) {
    return completeResult;
  }
  return {
    ...acknowledgement,
    resolvedOmitted: { reason: RESOLVED_OMITTED_REASON },
  };
}

const SessionsToolSchema = Type.Object(
  {
    action: stringEnum(ACTIONS, { description: "Action" }),
    sessionKey: Type.Optional(Type.String({ description: "Target session. Default: current" })),
    targets: Type.Optional(
      Type.Array(
        Type.Object(
          {
            sessionKey: Type.String({ minLength: 1 }),
            expectedSessionId: Type.Optional(Type.String({ minLength: 1 })),
          },
          { additionalProperties: false },
        ),
        {
          minItems: 1,
          maxItems: SESSIONS_PATCH_MANY_MAX_TARGETS,
          description:
            "patch: apply the same settings to these sessions. Cannot combine with top-level sessionKey/expectedSessionId. Archive/restore requires each target's expectedSessionId. Current-session archive uses a single patch. Results use zero-based succeeded/failed indexes; valid targets continue after item errors.",
        },
      ),
    ),
    expectedSessionId: Type.Optional(
      Type.String({
        description:
          "Durable identity returned by sessions_list; rejects a replaced session. Required for archive, restore, or delete of another session.",
      }),
    ),
    deleteTranscript: Type.Optional(
      Type.Boolean({ description: "Archive the deleted session transcript. Default: true." }),
    ),
    label: Type.Optional(
      Type.String({ description: "Sidebar title override. Empty string clears it." }),
    ),
    icon: Type.Optional(
      Type.String({
        description: `Persistent sidebar icon: a single emoji, or a named icon: ${SESSION_ICON_GLYPH_DESCRIPTION}. Empty string clears it. Distinct from attention, which is temporary.`,
      }),
    ),
    color: Type.Optional(
      Type.String({
        description: `Persistent sidebar color tint, one of: ${SESSION_COLOR_IDS.join(", ")}. Empty string clears it.`,
      }),
    ),
    group: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "patch: custom sidebar group for this session. Null or an empty string clears it back to ungrouped; assigning a new name creates the group.",
      }),
    ),
    statusNote: Type.Optional(
      Type.String({
        maxLength: 120,
        description:
          "Short sidebar status line. Empty string clears it and declared attention. Clears automatically when the user reads or replies, or when its TTL expires.",
      }),
    ),
    attention: Type.Optional(
      stringEnum(["clear", ...SESSION_AGENT_ATTENTION_ICON_IDS] as const, {
        description:
          "Request user attention with a curated icon; requires an active statusNote. 'clear' clears both attention and statusNote.",
      }),
    ),
    ttlMinutes: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 120,
        description: "Status/attention lifetime in minutes. Default 30; maximum 120.",
      }),
    ),
    pinned: Type.Optional(Type.Boolean({ description: "Pin session" })),
    archived: Type.Optional(
      Type.Boolean({ description: "True archives without deleting; false restores the session." }),
    ),
    model: Type.Optional(Type.String({ description: "Model override" })),
    thinkingLevel: Type.Optional(Type.String({ description: "Thinking override" })),
    ownerType: Type.Optional(
      stringEnum(["human", "agent"] as const, {
        description: "New owner kind for assign_owner",
      }),
    ),
    ownerId: Type.Optional(Type.String({ description: "New owner id for assign_owner" })),
    names: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "group_set: full replacement of the ordered group catalog. Array order becomes sidebar order; new names are created; empty groups left out are deleted. Dropping a group that still has member sessions is rejected — remove it with group_delete first. Never moves sessions. To reorder, pass the complete current list in the new order.",
      }),
    ),
    name: Type.Optional(
      Type.String({ description: "group_rename and group_delete: the group to act on." }),
    ),
    to: Type.Optional(Type.String({ description: "group_rename: the new group name." })),
  },
  { additionalProperties: false },
);

type SessionsToolOptions = {
  agentSessionKey?: string;
  agentSessionId?: string;
  requesterAgentIdOverride?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: AgentToolGatewayRequestCaller;
  hasInProcessGatewayContext?: () => boolean;
};

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ToolInputError(`${key} must be boolean`);
  }
  return value;
}

function readGroupName(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${label} required`);
  }
  const name = value.trim();
  if (name.length > GROUP_NAME_MAX_LENGTH) {
    throw new ToolInputError(`${label} too long`);
  }
  return name;
}

function readGroupNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ToolInputError("names required");
  }
  return value.map((name, index) => readGroupName(name, `names[${index}]`));
}

async function resolvePatchTarget(
  opts: SessionsToolOptions,
  sessionKey: string | undefined,
  callGateway: AgentToolGatewayRequestCaller,
): Promise<{
  agentId: string;
  cfg: OpenClawConfig;
  isRequesterSession: boolean;
  key: string;
  requesterAgentId: string;
  requesterSessionKey: string;
}> {
  const context = resolveSessionToolContext(opts);
  const rawKey = sessionKey ?? context.effectiveRequesterKey;
  const requesterAgentId = resolveSessionAgentId({
    config: context.cfg,
    sessionKey: context.effectiveRequesterKey,
    agentId: opts.requesterAgentIdOverride,
  });
  const normalizedRawKey = rawKey.trim();
  const isCurrentSession = normalizedRawKey === "current";
  const isConfiguredMainAlias =
    normalizedRawKey === "main" ||
    normalizedRawKey === "global" ||
    normalizedRawKey === context.mainKey ||
    normalizedRawKey === context.alias;
  const inputAgentId = isCurrentSession
    ? requesterAgentId
    : shouldResolveSessionIdInput(rawKey) && !isConfiguredMainAlias
      ? undefined
      : resolveSessionToolTargetAgentId({
          cfg: context.cfg,
          targetSessionKey: rawKey,
          requesterAgentId,
        });
  const resolved = await resolveSessionReference({
    action: "status",
    sessionKey: rawKey,
    agentId: inputAgentId,
    keyAgentId: requesterAgentId,
    alias: context.alias,
    mainKey: context.mainKey,
    requesterInternalKey: context.effectiveRequesterKey,
    restrictToSpawned: context.restrictToSpawned,
    callGateway,
  });
  if (!resolved.ok) {
    throw new ToolInputError(resolved.error);
  }
  if (isIncognitoSessionKey(resolved.key)) {
    throw new ToolAuthorizationError(`Session not visible from session tools: ${rawKey}`);
  }
  const agentId = resolveSessionToolTargetAgentId({
    cfg: context.cfg,
    targetSessionKey: resolved.key,
    resolvedAgentId: resolved.agentId,
    requesterAgentId,
  });
  const isRequesterSession =
    resolved.key === context.effectiveRequesterKey && agentId === requesterAgentId;
  if (!isRequesterSession) {
    // Session visibility is the configured read/write scope for session tools;
    // the action only selects error copy. Owner gating remains separate.
    const authorizationKey =
      agentId !== requesterAgentId && !parseAgentSessionKey(resolved.key)
        ? `agent:${agentId}:${resolved.key}`
        : resolved.key;
    const access = await resolveSessionToolAccess({
      action: "status",
      requesterSessionKey: context.effectiveRequesterKey,
      mainSessionKey: context.mainSessionKey,
      authorizationTargetSessionKey: authorizationKey,
      requesterAgentId,
      targetAgentId: agentId,
      targetSessionKey: resolved.key,
      requesterOwned: resolved.requesterOwned === true,
      visibility: context.sessionVisibility,
      a2aPolicy: context.a2aPolicy,
      callGateway,
    });
    if (!access.allowed) {
      throw new ToolAuthorizationError(
        formatSessionToolAccessDenial(access, {
          action: "status",
          targetSessionKey: resolved.displayKey,
        }),
      );
    }
  }
  return {
    agentId,
    cfg: context.cfg,
    isRequesterSession,
    key: resolved.key,
    requesterAgentId,
    requesterSessionKey: context.effectiveRequesterKey,
  };
}

export function createSessionsTool(opts: SessionsToolOptions = {}): AnyAgentTool {
  const gatewayRequest = opts.callGateway ?? callAgentToolGatewayRequest;
  const callGateway = <T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
  ) => gatewayRequest<T>({ method, params });
  return {
    label: "Sessions",
    name: "sessions",
    description:
      "Session settings, ownership, reset, delete, and custom sidebar groups: patch label/icon/group/status, pin, archive/restore, model/thinking override. patch with group files sessions into a group; targets applies the same patch to up to 100 visible sessions; group_list shows the catalog; group_set replaces the whole ordered catalog; group_rename/group_delete change one group everywhere. assign_owner hands responsibility to a human or agent; reset/delete visible sessions.",
    parameters: SessionsToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      if (
        params.targets !== undefined &&
        (action !== "patch" ||
          params.sessionKey !== undefined ||
          params.expectedSessionId !== undefined)
      ) {
        throw new ToolInputError(
          "targets is only valid for patch and cannot be combined with sessionKey or expectedSessionId",
        );
      }
      if (action === "reset" || action === "delete") {
        const rawKey = readToolStringParam(params, "sessionKey", { required: true });
        const { agentId, isRequesterSession, key } = await resolvePatchTarget(
          opts,
          rawKey,
          gatewayRequest,
        );
        if (isRequesterSession) {
          throw new ToolInputError(`Cannot ${action} the session running this tool`);
        }
        const agentScope = parseAgentSessionKey(key) ? {} : { agentId };
        if (action === "reset") {
          const result = await runSessionToolActionWithConflictReceipt({
            operation: "reset",
            targetAgentId: agentId,
            targetSessionKey: key,
            run: async () =>
              await callGateway("sessions.reset", {
                key,
                ...agentScope,
                reason: "reset",
              }),
          });
          recordSessionToolActionFact({
            operation: "reset",
            fact: "committed",
            targetAgentId: agentId,
            targetSessionKey: key,
          });
          return jsonResult(result);
        }
        // Archive returns the exact row generation. Carry it into the locked
        // delete so a concurrent reset cannot delete a replacement session.
        const expectedSessionId = normalizeOptionalString(
          readToolStringParam(params, "expectedSessionId"),
        );
        if (!expectedSessionId) {
          throw new ToolInputError("Session lifecycle action requires a durable session identity");
        }
        const archived = await runSessionToolActionWithConflictReceipt({
          operation: "delete",
          targetAgentId: agentId,
          targetSessionKey: key,
          run: async () =>
            await callGateway<{
              entry?: { sessionId?: string; lifecycleRevision?: string };
            }>("sessions.patch", {
              key,
              ...agentScope,
              expectedSessionId,
              archived: true,
            }),
        });
        const archivedSessionId = normalizeOptionalString(archived.entry?.sessionId);
        if (!archivedSessionId) {
          throw new ToolInputError("Session archive did not return its session identity");
        }
        const expectedLifecycleRevision = normalizeOptionalString(
          archived.entry?.lifecycleRevision,
        );
        const result = await runSessionToolActionWithConflictReceipt({
          operation: "delete",
          targetAgentId: agentId,
          targetSessionKey: key,
          run: async () =>
            await callGateway<{ deleted?: boolean }>("sessions.delete", {
              key,
              ...agentScope,
              archivedOnly: true,
              expectedSessionId: archivedSessionId,
              ...(expectedLifecycleRevision ? { expectedLifecycleRevision } : {}),
              deleteTranscript: readBooleanParam(params, "deleteTranscript") ?? true,
            }),
        });
        recordSessionToolActionFact({
          operation: "delete",
          // Archive is part of this composite action and already committed.
          // A delete miss therefore cannot make the whole operation a no-op.
          fact: "committed",
          targetAgentId: agentId,
          targetSessionKey: key,
        });
        return jsonResult(result);
      }
      if (action === "group_list") {
        return jsonResult(await callGateway("sessions.groups.list", {}));
      }
      if (action === "assign_owner") {
        const ownerType = readToolStringParam(params, "ownerType", { required: true });
        const ownerId = normalizeOptionalString(
          readToolStringParam(params, "ownerId", { required: true }),
        );
        if ((ownerType !== "human" && ownerType !== "agent") || !ownerId) {
          throw new ToolInputError("assign_owner requires ownerType and ownerId");
        }
        const { agentId, key, requesterAgentId, requesterSessionKey } = await resolvePatchTarget(
          opts,
          normalizeOptionalString(readToolStringParam(params, "sessionKey")),
          gatewayRequest,
        );
        const agentScope = parseAgentSessionKey(key) ? {} : { agentId };
        const result = await gatewayRequest<SessionsAssignOwnerResult>({
          method: "sessions.assignOwner",
          params: {
            key,
            ...agentScope,
            owner: { type: ownerType, id: ownerId },
          },
          agentToolCaller: { agentId: requesterAgentId, sessionKey: requesterSessionKey },
        });
        return jsonResult({
          status: "updated",
          sessionKey: result.key,
          owner: {
            type: result.owner.actor.type,
            id: result.owner.actor.id,
            ...(result.owner.actor.label ? { label: result.owner.actor.label } : {}),
          },
        });
      }
      // Group catalog is global by contract. Owner-only tool gating protects mutations.
      if (action === "group_set") {
        const names = readGroupNames(params.names);
        return jsonResult(await callGateway("sessions.groups.put", { names }));
      }
      if (action === "group_rename") {
        return jsonResult(
          await callGateway("sessions.groups.rename", {
            name: readGroupName(params.name, "name"),
            to: readGroupName(params.to, "to"),
          }),
        );
      }
      if (action === "group_delete") {
        return jsonResult(
          await callGateway("sessions.groups.delete", {
            name: readGroupName(params.name, "name"),
          }),
        );
      }
      if (action !== "patch") {
        throw new ToolInputError(`Unknown action: ${action}`);
      }

      const values = readSessionsToolPatch(params);
      const inProcessGatewayAvailable =
        opts.hasInProcessGatewayContext?.() ??
        (opts.callGateway ? true : hasInProcessGatewayToolContext());
      if (values.model !== undefined && !inProcessGatewayAvailable) {
        return jsonResult({ status: "forbidden", error: "Model patch needs in-process gateway." });
      }
      const patchGateway: AgentToolGatewayRequestCaller = async (request) =>
        values.model === undefined
          ? await gatewayRequest(request)
          : await withAgentSessionModelPatchOrigin(async () => await gatewayRequest(request));
      if (params.targets !== undefined) {
        return jsonResult(
          await runSessionsToolPatchMany({
            targets: params.targets,
            patch: values,
            resolveTarget: (sessionKey) => resolvePatchTarget(opts, sessionKey, gatewayRequest),
            callGateway: patchGateway,
          }),
        );
      }
      const { agentId, cfg, isRequesterSession, key } = await resolvePatchTarget(
        opts,
        normalizeOptionalString(readToolStringParam(params, "sessionKey")),
        gatewayRequest,
      );
      const archived = values.archived;
      const expectedSessionId =
        normalizeOptionalString(readToolStringParam(params, "expectedSessionId")) ??
        (typeof archived === "boolean" && isRequesterSession
          ? normalizeOptionalString(opts.agentSessionId)
          : undefined);
      if (typeof archived === "boolean" && !expectedSessionId) {
        throw new ToolInputError("Session lifecycle action requires a durable session identity");
      }
      const lifecycleIdentity:
        | { expectedSessionId: string; expectedLifecycleRevision?: string }
        | undefined = expectedSessionId ? { expectedSessionId } : undefined;
      const patch = { key, ...lifecycleIdentity, ...values };
      const callSessionPatch = (
        sessionPatch: typeof patch & { agentId?: string },
      ): Promise<SessionsPatchResult> =>
        patchGateway({ method: "sessions.patch", params: sessionPatch });
      const includeResolved = patch.model !== undefined || patch.thinkingLevel !== undefined;
      const agentScope = parseAgentSessionKey(key) ? {} : { agentId };

      if (patch.archived === true && isRequesterSession && key !== "global") {
        if (key !== resolveAgentMainSessionKey({ cfg, agentId })) {
          const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
          const currentEntry = loadSessionEntry({ agentId, sessionKey: key, storePath });
          const released = getSessionWorkAdmissionRelease({
            scope: storePath,
            identities: [key, currentEntry?.sessionId],
          });

          if (
            currentEntry?.sessionId === lifecycleIdentity?.expectedSessionId &&
            released &&
            lifecycleIdentity
          ) {
            const expectedSessionIdentity = lifecycleIdentity;
            const {
              archived: _archived,
              expectedSessionId: _expectedSessionId,
              expectedLifecycleRevision: _expectedLifecycleRevision,
              ...immediatePatch
            } = patch;
            let immediateResult: SessionsPatchResult | undefined;
            if (Object.keys(immediatePatch).length > 1) {
              immediateResult = await callSessionPatch({
                ...immediatePatch,
                ...agentScope,
                ...expectedSessionIdentity,
              });
            }

            // Archive only after the final tool result, transcript, and every
            // admitted owner have settled. Gateway-owned compare-and-swap
            // keeps a reset replacement from being archived between checks.
            runWithGatewayToolCleanupContext(() => {
              void released
                .then(async () => {
                  const archiveIdentities = [key, expectedSessionIdentity.expectedSessionId];
                  const archivePatch = {
                    key,
                    ...agentScope,
                    archived: true,
                    ...expectedSessionIdentity,
                  };
                  let unobservedRunRetries = 0;

                  while (true) {
                    const latestEntry = loadSessionEntry({ agentId, sessionKey: key, storePath });
                    if (
                      latestEntry?.sessionId !== expectedSessionIdentity.expectedSessionId ||
                      (expectedSessionIdentity.expectedLifecycleRevision !== undefined &&
                        latestEntry.lifecycleRevision !==
                          expectedSessionIdentity.expectedLifecycleRevision)
                    ) {
                      return;
                    }

                    const competingRelease = getSessionWorkAdmissionRelease({
                      scope: storePath,
                      identities: archiveIdentities,
                    });
                    if (competingRelease) {
                      unobservedRunRetries = 0;
                      await competingRelease;
                      continue;
                    }

                    try {
                      await callGateway("sessions.patch", archivePatch);
                      return;
                    } catch (error) {
                      // A new turn can enter after the idle check. Wait for that
                      // admitted owner, or retry a transient gateway disconnect,
                      // instead of losing an archive that was already scheduled.
                      const message = formatErrorMessage(error);
                      const retryableGatewayFailure =
                        error instanceof GatewayTransportError ||
                        isTransientNetworkError(error) ||
                        (typeof error === "object" &&
                          error !== null &&
                          "retryable" in error &&
                          error.retryable === true);
                      if (!retryableGatewayFailure) {
                        throw error;
                      }
                      log.warn(`retrying deferred self-archive for ${key}: ${message}`);
                      const retryAfterRelease = getSessionWorkAdmissionRelease({
                        scope: storePath,
                        identities: archiveIdentities,
                      });
                      if (retryAfterRelease) {
                        unobservedRunRetries = 0;
                        await retryAfterRelease;
                      } else {
                        // Projected work can outlive local admission tracking.
                        // Cap the interval, not the archive, so it cannot spin or
                        // abandon a session whose remote turn is still running.
                        const retryDelayMs = Math.min(
                          25 * 2 ** Math.min(unobservedRunRetries, 8),
                          SELF_ARCHIVE_MAX_RETRY_DELAY_MS,
                        );
                        await new Promise<void>((resolve) => {
                          // A pending self-archive must not keep a shutting-down
                          // gateway alive solely to retry its own transport.
                          const retryTimer = setTimeout(resolve, retryDelayMs);
                          retryTimer.unref?.();
                        });
                        unobservedRunRetries = Math.min(unobservedRunRetries + 1, 8);
                      }
                    }
                  }
                })
                .catch((error: unknown) => {
                  log.warn(`deferred self-archive failed for ${key}: ${formatErrorMessage(error)}`);
                });
            });

            recordSessionToolActionFact({
              operation: "archive",
              fact: "scheduled",
              targetAgentId: agentId,
              targetSessionKey: key,
            });

            return jsonResult(
              withBoundedSessionsResolved(
                {
                  status: "scheduled",
                  sessionKey: key,
                  message: "Session will be archived after the current agent run finishes.",
                },
                includeResolved ? immediateResult?.resolved : undefined,
              ),
            );
          }
        }
      }

      const operation =
        archived === true ? "archive" : archived === false ? "restore" : ("patch" as const);
      const result = await runSessionToolActionWithConflictReceipt({
        operation,
        targetAgentId: agentId,
        targetSessionKey: key,
        run: async () => await callSessionPatch({ ...patch, ...agentScope }),
      });
      recordSessionToolActionFact({
        operation,
        fact: "committed",
        targetAgentId: agentId,
        targetSessionKey: key,
      });
      return jsonResult(
        withBoundedSessionsResolved(
          {
            status: "updated",
            sessionKey: key,
            updated: Object.keys(patch).filter((field) => field !== "key"),
          },
          includeResolved ? result.resolved : undefined,
        ),
      );
    },
  };
}
