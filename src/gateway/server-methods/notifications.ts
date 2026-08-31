import type { Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  validateNotificationsSubscribeParams,
  validateNotificationsUnsubscribeParams,
  validateNotificationsPreferencesGetParams,
  validateNotificationsPreferencesSetParams,
  validateNotificationsTestParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  NativeNotificationError,
  NativeNotificationRegistry,
} from "../native-notifications.js";
import type { GatewayClient, GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

function notificationMethod<Params, Value>(
  method: string,
  validate: Validator<Params>,
  operation: (
    registry: NativeNotificationRegistry,
    client: GatewayClient | null,
    params: Params,
  ) => Result<Value, NativeNotificationError>,
): GatewayRequestHandler {
  return ({ params, client, context, respond }) => {
    if (!assertValidParams(params, validate, method, respond)) {
      return;
    }
    if (!context.nativeNotifications) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Native notifications are unavailable on this Gateway."),
      );
      return;
    }
    try {
      const result = operation(context.nativeNotifications, client, params);
      if (!result.ok) {
        respond(false, undefined, errorShape(result.error.code, result.error.message));
        return;
      }
      respond(true, result.value);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  };
}

export const notificationHandlers: GatewayRequestHandlers = {
  "notifications.subscribe": notificationMethod(
    "notifications.subscribe",
    validateNotificationsSubscribeParams,
    (registry, client, params) => registry.subscribe(client, params.enabled),
  ),
  "notifications.unsubscribe": notificationMethod(
    "notifications.unsubscribe",
    validateNotificationsUnsubscribeParams,
    (registry, client) => registry.unsubscribe(client),
  ),
  "notifications.preferences.get": notificationMethod(
    "notifications.preferences.get",
    validateNotificationsPreferencesGetParams,
    (registry, client) => registry.preferences(client),
  ),
  "notifications.preferences.set": notificationMethod(
    "notifications.preferences.set",
    validateNotificationsPreferencesSetParams,
    (registry, client, params) => registry.setPreferences(client, params),
  ),
  "notifications.test": notificationMethod(
    "notifications.test",
    validateNotificationsTestParams,
    (registry, client) => registry.test(client),
  ),
};
