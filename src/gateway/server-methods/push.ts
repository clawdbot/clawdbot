// Push gateway methods send APNs/web-push test notifications and manage web
// push subscriptions/VAPID public-key access for UI clients.
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validatePushTestParams,
  validateWebPushSubscribeParams,
  validateWebPushTestParams,
  validateWebPushUnsubscribeParams,
  validateWebPushVapidPublicKeyParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  shouldClearStoredApnsRegistration,
} from "../../infra/push-apns.js";
import {
  broadcastWebPush,
  clearWebPushSubscriptionByEndpoint,
  registerWebPushSubscription,
  resolveVapidKeys,
} from "../../infra/push-web.js";
import { respondUnavailableOnThrow } from "./nodes.helpers.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const pushHandlers: GatewayRequestHandlers = {
  "push.test": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validatePushTestParams, "push.test", respond)) {
      return;
    }

    const nodeId = normalizeStringifiedOptionalString(params.nodeId) ?? "";
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }

    const title = normalizeOptionalString(params.title) ?? "OpenClaw";
    const body = normalizeOptionalString(params.body) ?? `Push test for node ${nodeId}`;

    await respondUnavailableOnThrow(respond, async () => {
      const registration = await loadApnsRegistration(nodeId);
      if (!registration) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `node ${nodeId} has no APNs registration (connect iOS node first)`,
          ),
        );
        return;
      }

      const overrideEnvironment = normalizeApnsEnvironment(params.environment);
      const result =
        registration.transport === "direct"
          ? await (async () => {
              // Direct registrations require local APNs signing material at
              // send time; relay registrations must not touch those secrets.
              const auth = await resolveApnsAuthConfigFromEnv(process.env);
              if (!auth.ok) {
                respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, auth.error));
                return null;
              }
              return await sendApnsAlert({
                registration: {
                  ...registration,
                  environment: overrideEnvironment ?? registration.environment,
                },
                nodeId,
                title,
                body,
                auth: auth.value,
              });
            })()
          : await (async () => {
              // Relay registrations carry a grant from the node, so the gateway
              // only needs relay config plus the origin bound at registration.
              const relay = resolveApnsRelayConfigFromEnv(
                process.env,
                context.getRuntimeConfig().gateway,
                { registrationRelayOrigin: registration.relayOrigin },
              );
              if (!relay.ok) {
                respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, relay.error));
                return null;
              }
              return await sendApnsAlert({
                registration,
                nodeId,
                title,
                body,
                relayConfig: relay.value,
              });
            })();
      if (!result) {
        return;
      }
      if (
        shouldClearStoredApnsRegistration({
          registration,
          result,
          overrideEnvironment,
        })
      ) {
        // Clear only the exact registration we tested; a reconnect may have
        // written a newer token while the push request was in flight.
        await clearApnsRegistrationIfCurrent({
          nodeId,
          registration,
        });
      }
      respond(true, result, undefined);
    });
  },

  "push.web.vapidPublicKey": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateWebPushVapidPublicKeyParams,
        "push.web.vapidPublicKey",
        respond,
      )
    ) {
      return;
    }

    await respondUnavailableOnThrow(respond, async () => {
      const vapid = await resolveVapidKeys();
      respond(true, { vapidPublicKey: vapid.publicKey }, undefined);
    });
  },

  "push.web.subscribe": async ({ params, respond }) => {
    if (!assertValidParams(params, validateWebPushSubscribeParams, "push.web.subscribe", respond)) {
      return;
    }

    await respondUnavailableOnThrow(respond, async () => {
      const subscription = await registerWebPushSubscription({
        endpoint: params.endpoint,
        keys: params.keys,
      });
      respond(true, { subscriptionId: subscription.subscriptionId }, undefined);
    });
  },

  "push.web.unsubscribe": async ({ params, respond }) => {
    if (
      !assertValidParams(params, validateWebPushUnsubscribeParams, "push.web.unsubscribe", respond)
    ) {
      return;
    }

    await respondUnavailableOnThrow(respond, async () => {
      const removed = await clearWebPushSubscriptionByEndpoint(params.endpoint);
      respond(true, { removed }, undefined);
    });
  },

  "push.web.test": async ({ params, respond }) => {
    if (!assertValidParams(params, validateWebPushTestParams, "push.web.test", respond)) {
      return;
    }

    const title = normalizeOptionalString(params.title) ?? "OpenClaw";
    const body = normalizeOptionalString(params.body) ?? "Web push test notification";

    await respondUnavailableOnThrow(respond, async () => {
      const results = await broadcastWebPush({ title, body });
      if (results.length === 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "no web push subscriptions registered"),
        );
        return;
      }
      if (!results.some((result) => result.ok)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "all web push deliveries failed", {
            details: { results },
          }),
        );
        return;
      }
      respond(true, { results }, undefined);
    });
  },
};
