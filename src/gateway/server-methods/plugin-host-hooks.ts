// Plugin host hook methods expose plugin UI descriptors and validate plugin
// session action payload/result JSON against declared schemas.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  missingScopeErrorShape,
  validatePluginsSessionActionParams,
  validatePluginsSessionActionResult,
  validatePluginsUiDescriptorsParams,
  validatePluginsUiDescriptorsResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPluginJsonValue } from "../../plugins/host-hooks.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  validateJsonSchemaValue,
  type JsonSchemaValidationError,
  type JsonSchemaValue,
} from "../../plugins/schema-validator.js";
import { ADMIN_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("gateway/plugin-host-hooks");

function formatSessionActionPayloadSchemaErrors(errors: JsonSchemaValidationError[]): string {
  return errors.map((error) => error.text).join("; ");
}

/** Ensures plugin action result extension fields stay JSON-compatible on the wire. */
function validatePluginSessionActionJsonFields(
  result: Record<string, unknown>,
): string | undefined {
  for (const field of ["result", "reply", "details"] as const) {
    if (result[field] !== undefined && !isPluginJsonValue(result[field])) {
      return `plugin session action ${field} must be JSON-compatible`;
    }
  }
  return undefined;
}

/** Gateway handlers for plugin-declared Control UI descriptors and session actions. */
export const pluginHostHookHandlers: GatewayRequestHandlers = {
  "plugins.uiDescriptors": ({ params, respond }) => {
    if (!validatePluginsUiDescriptorsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plugins.uiDescriptors params: ${formatValidationErrors(validatePluginsUiDescriptorsParams.errors)}`,
        ),
      );
      return;
    }
    const descriptors = (getActivePluginRegistry()?.controlUiDescriptors ?? []).map((entry) => {
      const descriptor: Record<string, unknown> = {
        id: entry.descriptor.id,
        pluginId: entry.pluginId,
        pluginName: entry.pluginName,
        surface: entry.descriptor.surface,
        label: entry.descriptor.label,
      };
      if (entry.descriptor.description !== undefined) {
        descriptor.description = entry.descriptor.description;
      }
      if (entry.descriptor.placement !== undefined) {
        descriptor.placement = entry.descriptor.placement;
      }
      if (entry.descriptor.schema !== undefined) {
        descriptor.schema = entry.descriptor.schema;
      }
      if (entry.descriptor.requiredScopes !== undefined) {
        descriptor.requiredScopes = entry.descriptor.requiredScopes;
      }
      return descriptor;
    });
    const result = { ok: true, descriptors };
    if (!validatePluginsUiDescriptorsResult(result)) {
      log.warn("invalid plugins.uiDescriptors result", {
        errors: validatePluginsUiDescriptorsResult.errors,
      });
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `invalid plugins.uiDescriptors result: ${formatValidationErrors(validatePluginsUiDescriptorsResult.errors)}`,
        ),
      );
      return;
    }
    respond(true, result, undefined);
  },
  "plugins.sessionAction": async ({ params, client, respond }) => {
    if (!validatePluginsSessionActionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plugins.sessionAction params: ${formatValidationErrors(validatePluginsSessionActionParams.errors)}`,
        ),
      );
      return;
    }
    const pluginId = normalizeOptionalString(params.pluginId);
    const actionId = normalizeOptionalString(params.actionId);
    const sessionKey = normalizeOptionalString(params.sessionKey);
    if (!pluginId || !actionId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "plugins.sessionAction pluginId and actionId must be non-empty",
        ),
      );
      return;
    }
    const registry = getActivePluginRegistry();
    const pluginLoaded = Boolean(
      registry?.plugins.some((plugin) => plugin.id === pluginId && plugin.status === "loaded"),
    );
    const registration = (registry?.sessionActions ?? []).find(
      (entry) => entry.pluginId === pluginId && entry.action.id === actionId,
    );
    if (!registration || !pluginLoaded) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `unknown plugin session action: ${pluginId}/${actionId}`,
        ),
      );
      return;
    }
    const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
    const hasAdmin = scopes.includes(ADMIN_SCOPE);
    const requiredScopes =
      registration.action.requiredScopes && registration.action.requiredScopes.length > 0
        ? registration.action.requiredScopes
        : [WRITE_SCOPE];
    // Plugin actions default to write access, while read-only actions can opt
    // down. Admin bypasses all checks and write includes read for UI callers.
    const missingScope = requiredScopes.find(
      (scope) =>
        !hasAdmin &&
        !scopes.includes(scope) &&
        !(scope === READ_SCOPE && scopes.includes(WRITE_SCOPE)),
    );
    if (missingScope) {
      respond(false, undefined, missingScopeErrorShape({ missingScope, requiredScopes }));
      return;
    }
    try {
      if (params.payload !== undefined && !isPluginJsonValue(params.payload)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "plugin session action payload must be JSON-compatible",
          ),
        );
        return;
      }
      if (registration.action.schema !== undefined) {
        if (
          typeof registration.action.schema !== "boolean" &&
          !isRecord(registration.action.schema)
        ) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "plugin session action schema must be an object or boolean",
            ),
          );
          return;
        }
        // Schemas are plugin-provided data; validate their shape before passing
        // them into the shared schema evaluator so malformed plugins fail cleanly.
        const validation = validateJsonSchemaValue({
          schema: registration.action.schema as JsonSchemaValue,
          cacheKey: `plugin-session-action:${pluginId}:${actionId}`,
          value: params.payload,
        });
        if (!validation.ok) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `plugin session action payload does not match schema: ${formatSessionActionPayloadSchemaErrors(validation.errors)}`,
            ),
          );
          return;
        }
      }
      const result = await registration.action.handler({
        pluginId,
        actionId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(params.payload !== undefined ? { payload: params.payload } : {}),
        client: {
          ...(client?.connId ? { connId: client.connId } : {}),
          scopes: [...scopes],
        },
      });
      if (result !== undefined && !isRecord(result)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "plugin session action result must be an object"),
        );
        return;
      }
      const wireResult = result?.ok === false ? result : { ok: true as const, ...result };
      if (!validatePluginsSessionActionResult(wireResult)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin session action result: ${formatValidationErrors(validatePluginsSessionActionResult.errors)}`,
          ),
        );
        return;
      }
      const jsonFieldError = result ? validatePluginSessionActionJsonFields(result) : undefined;
      if (jsonFieldError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, jsonFieldError));
        return;
      }
      if (!wireResult.ok) {
        // Plugin-declared action failures are returned as a successful RPC
        // with `ok: false` per PluginsSessionActionResultSchema. Reserve
        // transport errorShape for protocol-level failures (validation,
        // schema mismatch, dispatch error). Distinguishing these in the
        // wire shape lets callers handle plugin failures (often retryable
        // or user-facing) differently from transport errors (operator
        // diagnostics).
        respond(
          true,
          {
            ok: false,
            error: wireResult.error,
            ...(wireResult.code !== undefined ? { code: wireResult.code } : {}),
            ...(wireResult.details !== undefined ? { details: wireResult.details } : {}),
          },
          undefined,
        );
        return;
      }
      respond(true, {
        ok: true,
        ...(wireResult.result !== undefined ? { result: wireResult.result } : {}),
        ...(wireResult.continueAgent !== undefined
          ? { continueAgent: wireResult.continueAgent }
          : {}),
        ...(wireResult.reply !== undefined ? { reply: wireResult.reply } : {}),
      });
    } catch (error) {
      log.warn(
        `plugin session action failed plugin=${pluginId} action=${actionId}: ${formatErrorMessage(error)}`,
      );
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "plugin session action failed"));
    }
  },
};
