/** Session self-service tool. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import type { SessionsPatchResult } from "../../../packages/gateway-protocol/src/index.js";
import { SESSION_AGENT_ATTENTION_ICON_IDS } from "../../../packages/gateway-protocol/src/session-icon.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayTransportError } from "../../gateway/call.js";
import { withAgentSessionModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { boundedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { isTransientNetworkError } from "../../infra/unhandled-rejections.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  getCurrentSessionWorkAdmissionRelease,
  getSessionWorkAdmissionRelease,
  SESSION_ARCHIVE_ACTIVE_RUN_ERROR,
} from "../../sessions/session-lifecycle-admission.js";
import { resolveDefaultAgentId } from "../agent-scope-config.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolAuthorizationError, ToolInputError } from "./common.js";
import {
  callInProcessGatewayTool,
  hasInProcessGatewayToolContext,
  type InProcessGatewayCaller,
} from "./in-process-gateway.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
} from "./sessions-access.js";
import { resolveSessionToolContext } from "./sessions-helpers.js";
import { resolveSessionReference } from "./sessions-resolution.js";

const ACTIONS = [
  "patch",
  "reset",
  "delete",
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
    deleteTranscript: Type.Optional(
      Type.Boolean({ description: "Archive the deleted session transcript. Default: true." }),
    ),
    label: Type.Optional(
      Type.String({ description: "Sidebar title override. Empty string clears it." }),
    ),
    icon: Type.Optional(
      Type.String({
        description:
          "Sidebar icon: an emoji, name:<curated-id>, or svg:<svg …> you draw yourself (tiny, sanitized). Empty string removes it.",
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
    names: Type.Optional(Type.Array(Type.String(), { description: "Ordered group names" })),
    name: Type.Optional(Type.String({ description: "Group name" })),
    to: Type.Optional(Type.String({ description: "New group name" })),
  },
  { additionalProperties: false },
);

type SessionsToolOptions = {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: InProcessGatewayCaller;
  hasInProcessGatewayContext?: () => boolean;
};

function readBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
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
): Promise<{ cfg: OpenClawConfig; key: string; requesterKey: string }> {
  const context = resolveSessionToolContext(opts);
  const rawKey = sessionKey ?? context.effectiveRequesterKey;
  const resolved = await resolveSessionReference({
    sessionKey: rawKey,
    alias: context.alias,
    mainKey: context.mainKey,
    requesterInternalKey: context.effectiveRequesterKey,
    restrictToSpawned: context.restrictToSpawned,
  });
  if (!resolved.ok) {
    throw new ToolInputError(resolved.error);
  }
  if (isIncognitoSessionKey(resolved.key)) {
    throw new ToolAuthorizationError(`Session not visible from session tools: ${rawKey}`);
  }
  if (resolved.key !== context.effectiveRequesterKey) {
    // Session visibility is the configured read/write scope for session tools;
    // the action only selects error copy. Owner gating remains separate.
    const guard = await createSessionVisibilityGuard({
      action: "status",
      defaultAgentId: resolveDefaultAgentId(context.cfg),
      requesterSessionKey: context.effectiveRequesterKey,
      requesterAgentId: resolveAgentIdFromSessionKey(
        context.effectiveRequesterKey,
        resolveDefaultAgentId(context.cfg),
      ),
      visibility: resolveEffectiveSessionToolsVisibility({
        cfg: context.cfg,
        sandboxed: opts.sandboxed === true,
      }),
      a2aPolicy: createAgentToAgentPolicy(context.cfg),
    });
    const access = guard.check(resolved.key);
    if (!access.allowed) {
      throw new ToolAuthorizationError(access.error);
    }
  }
  return {
    cfg: context.cfg,
    key: resolved.key,
    requesterKey: context.effectiveRequesterKey,
  };
}

export function createSessionsTool(opts: SessionsToolOptions = {}): AnyAgentTool {
  const gatewayCall = opts.callGateway ?? callInProcessGatewayTool;
  return {
    label: "Sessions",
    name: "sessions",
    description:
      "Session settings, reset, delete, and groups: patch label/icon/status, pin, archive/restore, model/thinking override; reset/delete visible sessions; group_list/group_set/group_rename/group_delete.",
    parameters: SessionsToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action === "reset" || action === "delete") {
        const rawKey = readStringParam(params, "sessionKey", { required: true });
        const { key } = await resolvePatchTarget(
          { ...opts, config: opts.config ?? getRuntimeConfig() },
          rawKey,
        );
        const context = resolveSessionToolContext({
          ...opts,
          config: opts.config ?? getRuntimeConfig(),
        });
        if (key === context.effectiveRequesterKey) {
          throw new ToolInputError(`Cannot ${action} the session running this tool`);
        }
        if (action === "reset") {
          return jsonResult(await gatewayCall("sessions.reset", { key, reason: "reset" }));
        }
        // Archive returns the exact row generation. Carry it into the locked
        // delete so a concurrent reset cannot delete a replacement session.
        const archived = await gatewayCall<{
          entry?: { sessionId?: string; lifecycleRevision?: string };
        }>("sessions.patch", { key, archived: true });
        const expectedSessionId = normalizeOptionalString(archived.entry?.sessionId);
        if (!expectedSessionId) {
          throw new ToolInputError("Session archive did not return its session identity");
        }
        const expectedLifecycleRevision = normalizeOptionalString(
          archived.entry?.lifecycleRevision,
        );
        return jsonResult(
          await gatewayCall("sessions.delete", {
            key,
            archivedOnly: true,
            expectedSessionId,
            ...(expectedLifecycleRevision ? { expectedLifecycleRevision } : {}),
            deleteTranscript: readBoolean(params, "deleteTranscript") ?? true,
          }),
        );
      }
      if (action === "group_list") {
        return jsonResult(await gatewayCall("sessions.groups.list", {}));
      }
      // Group catalog is global by contract. Owner-only tool gating protects mutations.
      if (action === "group_set") {
        const names = readGroupNames(params.names);
        return jsonResult(await gatewayCall("sessions.groups.put", { names }));
      }
      if (action === "group_rename") {
        return jsonResult(
          await gatewayCall("sessions.groups.rename", {
            name: readGroupName(params.name, "name"),
            to: readGroupName(params.to, "to"),
          }),
        );
      }
      if (action === "group_delete") {
        return jsonResult(
          await gatewayCall("sessions.groups.delete", {
            name: readGroupName(params.name, "name"),
          }),
        );
      }
      if (action !== "patch") {
        throw new ToolInputError(`Unknown action: ${action}`);
      }

      const { cfg, key, requesterKey } = await resolvePatchTarget(
        { ...opts, config: opts.config ?? getRuntimeConfig() },
        normalizeOptionalString(readStringParam(params, "sessionKey")),
      );
      const patch = {
        key,
        ...(params.label !== undefined ? { label: readClearableString(params, "label") } : {}),
        ...(params.icon !== undefined ? { icon: readClearableString(params, "icon") } : {}),
        ...(params.statusNote !== undefined
          ? { statusNote: readClearableString(params, "statusNote") }
          : {}),
        ...(params.attention !== undefined
          ? {
              attention:
                readStringParam(params, "attention", { required: true }) === "clear"
                  ? null
                  : readStringParam(params, "attention", { required: true }),
            }
          : {}),
        ...(params.ttlMinutes !== undefined
          ? { ttlMinutes: readInteger(params, "ttlMinutes") }
          : {}),
        ...(params.pinned !== undefined ? { pinned: readBoolean(params, "pinned") } : {}),
        ...(params.archived !== undefined ? { archived: readBoolean(params, "archived") } : {}),
        ...(params.model !== undefined
          ? { model: readStringParam(params, "model", { required: true }) }
          : {}),
        ...(params.thinkingLevel !== undefined
          ? { thinkingLevel: readStringParam(params, "thinkingLevel", { required: true }) }
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
      const callSessionPatch = async (sessionPatch: typeof patch): Promise<SessionsPatchResult> =>
        sessionPatch.model === undefined
          ? await gatewayCall<SessionsPatchResult>("sessions.patch", sessionPatch)
          : await withAgentSessionModelPatchOrigin(
              async () => await gatewayCall<SessionsPatchResult>("sessions.patch", sessionPatch),
            );
      const includeResolved = patch.model !== undefined || patch.thinkingLevel !== undefined;

      if (patch.archived === true && key === requesterKey && key !== "global") {
        const agentId = resolveAgentIdFromSessionKey(key, resolveDefaultAgentId(cfg));
        if (key !== resolveAgentMainSessionKey({ cfg, agentId })) {
          const storePath = resolveStorePath(cfg.session?.store, { agentId });
          const currentEntry = loadSessionEntry({ agentId, sessionKey: key, storePath });
          const released = getCurrentSessionWorkAdmissionRelease({
            scope: storePath,
            identities: [key, currentEntry?.sessionId],
          });

          if (currentEntry && released) {
            const expectedSessionIdentity = {
              expectedSessionId: currentEntry.sessionId,
              ...(currentEntry.lifecycleRevision
                ? { expectedLifecycleRevision: currentEntry.lifecycleRevision }
                : {}),
            };
            const { archived: _archived, ...immediatePatch } = patch;
            let immediateResult: SessionsPatchResult | undefined;
            if (Object.keys(immediatePatch).length > 1) {
              immediateResult = await callSessionPatch({
                ...immediatePatch,
                ...expectedSessionIdentity,
              });
            }

            // Archive only after the final tool result, transcript, and every
            // admitted owner have settled. Gateway-owned compare-and-swap
            // keeps a reset replacement from being archived between checks.
            void released
              .then(async () => {
                const archiveIdentities = [key, currentEntry.sessionId];
                const archivePatch = {
                  key,
                  archived: true,
                  ...expectedSessionIdentity,
                };
                let unobservedRunRetries = 0;

                while (true) {
                  const latestEntry = loadSessionEntry({ agentId, sessionKey: key, storePath });
                  if (
                    latestEntry?.sessionId !== currentEntry.sessionId ||
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
                    await gatewayCall("sessions.patch", archivePatch);
                    return;
                  } catch (error) {
                    // A new turn can enter after the idle check. Wait for that
                    // admitted owner, or retry a transient gateway disconnect,
                    // instead of losing an archive that was already scheduled.
                    const message = formatErrorMessage(error);
                    const activeRun = message.includes(SESSION_ARCHIVE_ACTIVE_RUN_ERROR);
                    const retryableGatewayFailure =
                      error instanceof GatewayTransportError ||
                      isTransientNetworkError(error) ||
                      (typeof error === "object" &&
                        error !== null &&
                        "retryable" in error &&
                        error.retryable === true);
                    if (!activeRun && !retryableGatewayFailure) {
                      throw error;
                    }
                    if (!activeRun) {
                      log.warn(`retrying deferred self-archive for ${key}: ${message}`);
                    }
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

      const result = await callSessionPatch(patch);
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
