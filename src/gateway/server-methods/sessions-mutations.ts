// Session metadata mutations, plugin state, and reset routing.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionsPatchManyResult,
  validateSessionsPatchManyParams,
  validateSessionsPatchParams,
  validateSessionsPluginPatchParams,
  validateSessionsResetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { patchPluginSessionExtension } from "../../plugins/host-hook-state.js";
import { isPluginJsonValue } from "../../plugins/host-hooks.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { executeSessionPatchEngine } from "./sessions-patch-engine.js";
import { loadSessionsRuntimeModule, requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionMutationHandlers: GatewayRequestHandlers = {
  "sessions.patchMany": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (
      !assertValidParams(params, validateSessionsPatchManyParams, "sessions.patchMany", respond)
    ) {
      return;
    }
    const executed = await executeSessionPatchEngine({
      authorizationMode: "target",
      client,
      context,
      patch: params.patch,
      sessionMutationAuthorization,
      targets: params.targets,
    });
    if (!executed.ok) {
      respond(false, undefined, executed.error);
      return;
    }
    const outcomes: SessionsPatchManyResult["outcomes"] = executed.outcomes.map((outcome) => {
      if (!outcome.ok) {
        return outcome;
      }
      return outcome.agentId
        ? { ok: true, key: outcome.key, agentId: outcome.agentId }
        : { ok: true, key: outcome.key };
    });
    respond(true, { outcomes } satisfies SessionsPatchManyResult, undefined);
  },
  "sessions.patch": async ({ params, respond, context, client, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const executed = await executeSessionPatchEngine({
      authorizationMode: "request",
      client,
      context,
      patch: params,
      sessionMutationAuthorization,
      targets: [
        {
          key,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(params.expectedSessionId !== undefined
            ? { expectedSessionId: params.expectedSessionId }
            : {}),
          ...(params.expectedLifecycleRevision !== undefined
            ? { expectedLifecycleRevision: params.expectedLifecycleRevision }
            : {}),
        },
      ],
    });
    if (!executed.ok) {
      respond(false, undefined, executed.error);
      return;
    }
    const outcome = executed.outcomes[0];
    if (!outcome) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Session patch failed unexpectedly. Retry the request.",
          {
            retryable: true,
          },
        ),
      );
      return;
    }
    if (!outcome.ok) {
      respond(false, undefined, outcome.error);
      return;
    }
    if (!outcome.result) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Session patch failed unexpectedly. Retry the request.",
          {
            retryable: true,
          },
        ),
      );
      return;
    }
    respond(true, outcome.result, undefined);
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
      authorizedPluginId: normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId),
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
