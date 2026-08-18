/** Session self-service tool. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import type {
  SessionsAssignOwnerResult,
  SessionsPatchResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  SESSION_AGENT_ATTENTION_ICON_IDS,
  SESSION_ICON_GLYPH_IDS,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayTransportError } from "../../gateway/call.js";
import { withAgentSessionModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { boundedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
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
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { resolveSessionToolTargetAgentId } from "./scoped-session-access.js";
import {
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionToolAccess,
} from "./sessions-access.js";
import { resolveSessionToolContext } from "./sessions-helpers.js";
import { resolveSessionReference, shouldResolveSessionIdInput } from "./sessions-resolution.js";

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
const GROUP_NAMES_MAX_ITEMS = 200;
const SELF_ARCHIVE_MAX_RETRY_DELAY_MS = 5_000;
const SESSIONS_TOOL_RESULT_MAX_BYTES = 3_840;
const RESOLVED_OMITTED_REASON = "response_budget_exceeded";
const SESSION_ICON_GLYPH_DESCRIPTION = SESSION_ICON_GLYPH_IDS.join(", ");
const log = createSubsystemLogger("agents/sessions");

type SessionsResolved = NonNullable<SessionsPatchResult["resolved"]>;

function sessionsToolResultFitsBudget(payload: Record<string, unknown>): boolean {
  const compactSize = boundedJsonUtf8Bytes(payload, SESSIONS_TOOL_RESULT_MAX_BYTES);
  if (!compactSize.complete || compactSize.bytes > SESSIONS_TOOL_RESULT_MAX_BYTES) {
    return false;
  }
  return (
    Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8") <= SESSIONS_TOOL_RESULT_MAX_BYTES
  );
}

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
    expectedSessionId: Type.Optional(
      Type.String({
        description:
          "Durable identity returned by sessions_list; required for archive, restore, or delete of another session.",
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
    names: Type.Optional(Type.Array(Type.String(), { description: "Ordered group names" })),
    name: Type.Optional(Type.String({ description: "Group name" })),
    to: Type.Optional(Type.String({ description: "New group name" })),
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

function readInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    throw new ToolInputError(`${key} must be an integer`);
  }
  return value as number;
}

function readClearableString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ToolInputError(`${key} must be a string`);
  }
  return value.trim() || null;
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
  if (value.length > GROUP_NAMES_MAX_ITEMS) {
    throw new ToolInputError("Too many group names");
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
      visibility: resolveEffectiveSessionToolsVisibility({
        cfg: context.cfg,
        sandboxed: opts.sandboxed === true,
      }),
      a2aPolicy: createAgentToAgentPolicy(context.cfg),
      callGateway,
    });
    if (!access.allowed) {
      throw new ToolAuthorizationError(access.error);
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
      "Session settings, ownership, reset, delete, and groups: patch label/icon/status, pin, archive/restore, model/thinking override; assign_owner hands responsibility to a human or agent; reset/delete visible sessions; group_list/group_set/group_rename/group_delete.",
    parameters: SessionsToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      if (action === "reset" || action === "delete") {
        const rawKey = readToolStringParam(params, "sessionKey", { required: true });
        const { agentId, isRequesterSession, key } = await resolvePatchTarget(
          { ...opts, config: opts.config ?? getRuntimeConfig() },
          rawKey,
          gatewayRequest,
        );
        if (isRequesterSession) {
          throw new ToolInputError(`Cannot ${action} the session running this tool`);
        }
        const agentScope = parseAgentSessionKey(key) ? {} : { agentId };
        if (action === "reset") {
          return jsonResult(
            await callGateway("sessions.reset", { key, ...agentScope, reason: "reset" }),
          );
        }
        // Archive returns the exact row generation. Carry it into the locked
        // delete so a concurrent reset cannot delete a replacement session.
        const expectedSessionId = normalizeOptionalString(
          readToolStringParam(params, "expectedSessionId"),
        );
        if (!expectedSessionId) {
          throw new ToolInputError("Session lifecycle action requires a durable session identity");
        }
        const archived = await callGateway<{
          entry?: { sessionId?: string; lifecycleRevision?: string };
        }>("sessions.patch", {
          key,
          ...agentScope,
          expectedSessionId,
          archived: true,
        });
        const archivedSessionId = normalizeOptionalString(archived.entry?.sessionId);
        if (!archivedSessionId) {
          throw new ToolInputError("Session archive did not return its session identity");
        }
        const expectedLifecycleRevision = normalizeOptionalString(
          archived.entry?.lifecycleRevision,
        );
        return jsonResult(
          await callGateway("sessions.delete", {
            key,
            ...agentScope,
            archivedOnly: true,
            expectedSessionId: archivedSessionId,
            ...(expectedLifecycleRevision ? { expectedLifecycleRevision } : {}),
            deleteTranscript: readBooleanParam(params, "deleteTranscript") ?? true,
          }),
        );
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
          { ...opts, config: opts.config ?? getRuntimeConfig() },
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

      const { agentId, cfg, isRequesterSession, key } = await resolvePatchTarget(
        { ...opts, config: opts.config ?? getRuntimeConfig() },
        normalizeOptionalString(readToolStringParam(params, "sessionKey")),
        gatewayRequest,
      );
      const archived =
        params.archived !== undefined ? readBooleanParam(params, "archived") : undefined;
      let lifecycleIdentity:
        | { expectedSessionId: string; expectedLifecycleRevision?: string }
        | undefined;
      if (typeof archived === "boolean") {
        const expectedSessionId =
          normalizeOptionalString(readToolStringParam(params, "expectedSessionId")) ??
          (isRequesterSession ? normalizeOptionalString(opts.agentSessionId) : undefined);
        if (!expectedSessionId) {
          throw new ToolInputError("Session lifecycle action requires a durable session identity");
        }
        lifecycleIdentity = { expectedSessionId };
      }
      const patch = {
        key,
        ...lifecycleIdentity,
        ...(params.label !== undefined ? { label: readClearableString(params, "label") } : {}),
        ...(params.icon !== undefined ? { icon: readClearableString(params, "icon") } : {}),
        ...(params.statusNote !== undefined
          ? { statusNote: readClearableString(params, "statusNote") }
          : {}),
        ...(params.attention !== undefined
          ? {
              attention:
                readToolStringParam(params, "attention", { required: true }) === "clear"
                  ? null
                  : readToolStringParam(params, "attention", { required: true }),
            }
          : {}),
        ...(params.ttlMinutes !== undefined
          ? { ttlMinutes: readInteger(params, "ttlMinutes") }
          : {}),
        ...(params.pinned !== undefined ? { pinned: readBooleanParam(params, "pinned") } : {}),
        ...(archived !== undefined ? { archived } : {}),
        ...(params.model !== undefined
          ? { model: readToolStringParam(params, "model", { required: true }) }
          : {}),
        ...(params.thinkingLevel !== undefined
          ? { thinkingLevel: readToolStringParam(params, "thinkingLevel", { required: true }) }
          : {}),
      };
      if (Object.keys(patch).length === 1) {
        throw new ToolInputError("Patch setting required");
      }
      const inProcessGatewayAvailable =
        opts.hasInProcessGatewayContext?.() ??
        (opts.callGateway ? true : hasInProcessGatewayToolContext());
      if (patch.model !== undefined && !inProcessGatewayAvailable) {
        return jsonResult({
          status: "forbidden",
          error: "Model patch needs in-process gateway.",
        });
      }
      const callSessionPatch = async (
        sessionPatch: typeof patch & { agentId?: string },
      ): Promise<SessionsPatchResult> =>
        sessionPatch.model === undefined
          ? await callGateway<SessionsPatchResult>("sessions.patch", sessionPatch)
          : await withAgentSessionModelPatchOrigin(
              async () => await callGateway<SessionsPatchResult>("sessions.patch", sessionPatch),
            );
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

      const result = await callSessionPatch({ ...patch, ...agentScope });
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
