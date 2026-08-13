// Session metadata mutations, plugin state, and reset routing.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsPatchManyParams,
  validateSessionsPatchParams,
  validateSessionsPluginPatchParams,
  validateSessionsResetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { patchPluginSessionExtension } from "../../plugins/host-hook-state.js";
import { isPluginJsonValue } from "../../plugins/host-hooks.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { executeSessionPatch, executeSessionPatchMany } from "./sessions-patch-engine.js";
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
    const executed = await executeSessionPatchMany({
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
    respond(true, { outcomes: executed.outcomes }, undefined);
  },
  "sessions.patch": async ({ params, respond, context, client, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    // Beta v4 clients may still send the retired icon field. Drop it at the
    // Gateway boundary so it cannot re-enter session state or patch hooks.
    const canonicalParams = { ...params } as typeof params & { icon?: unknown };
    delete canonicalParams.icon;
    const key = requireSessionKey(canonicalParams.key, respond);
    if (!key) {
      return;
    }
    const executed = await executeSessionPatch({
      client,
      context,
      patch: { ...canonicalParams, key },
      sessionMutationAuthorization,
    });
    if (!executed.ok) {
      respond(false, undefined, executed.error);
      return;
    }
    respond(true, executed.result, undefined);
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
    const requestedAgent = resolveRequestedSessionAgentId(
      context.getRuntimeConfig(),
      key,
      params.agentId,
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const canonicalKey = resolveStoredSessionKeyForAgentStore({
      cfg: context.getRuntimeConfig(),
      agentId: requestedAgent.agentId,
      sessionKey: key,
    });
    const patched = await patchPluginSessionExtension({
      cfg: context.getRuntimeConfig(),
      sessionKey: canonicalKey,
      agentId: requestedAgent.agentId,
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
      agentId: requestedAgent.agentId,
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
      workerPlacementContext: context,
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
      agentId: result.agentId,
      reason,
    });
  },
};
