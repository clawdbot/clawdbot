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
import { normalizeStringifiedOptionalString } from "../../shared/string-coerce.js";
import {
  ErrorCodes,
  errorShape,
  validatePushTestParams,
  validateWebPushSubscribeParams,
  validateWebPushTestParams,
  validateWebPushUnsubscribeParams,
  validateWebPushVapidPublicKeyParams,
} from "../protocol/index.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import { normalizeTrimmedString } from "./record-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

export const pushHandlers: GatewayRequestHandlers = {
  "push.test": async ({ params, respond, context }) => {
    if (!validatePushTestParams(params)) {
      respondInvalidParams({
        respond,
        method: "push.test",
        validator: validatePushTestParams,
      });
      return;
    }

    const nodeId = normalizeStringifiedOptionalString(params.nodeId) ?? "";
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }

    const title = normalizeTrimmedString(params.title) ?? "OpenClaw";
    const body = normalizeTrimmedString(params.body) ?? `Push test for node ${nodeId}`;

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
              const relay = resolveApnsRelayConfigFromEnv(
                process.env,
                context.getRuntimeConfig().gateway,
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
        await clearApnsRegistrationIfCurrent({
          nodeId,
          registration,
        });
      }
      respond(true, result, undefined);
    });
  },

  "push.web.vapidPublicKey": async ({ params, respond }) => {
    if (!validateWebPushVapidPublicKeyParams(params)) {
      respondInvalidParams({
        respond,
        method: "push.web.vapidPublicKey",
        validator: validateWebPushVapidPublicKeyParams,
      });
      return;
    }

    await respondUnavailableOnThrow(respond, async () => {
      const vapid = await resolveVapidKeys();
      respond(true, { vapidPublicKey: vapid.publicKey }, undefined);
    });
  },

  "push.web.subscribe": async ({ params, respond }) => {
    if (!validateWebPushSubscribeParams(params)) {
      respondInvalidParams({
        respond,
        method: "push.web.subscribe",
        validator: validateWebPushSubscribeParams,
      });
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
    if (!validateWebPushUnsubscribeParams(params)) {
      respondInvalidParams({
        respond,
        method: "push.web.unsubscribe",
        validator: validateWebPushUnsubscribeParams,
      });
      return;
    }

    await respondUnavailableOnThrow(respond, async () => {
      const removed = await clearWebPushSubscriptionByEndpoint(params.endpoint);
      respond(true, { removed }, undefined);
    });
  },

  "push.web.test": async ({ params, respond }) => {
    if (!validateWebPushTestParams(params)) {
      respondInvalidParams({
        respond,
        method: "push.web.test",
        validator: validateWebPushTestParams,
      });
      return;
    }

    const title = normalizeTrimmedString(params.title) ?? "OpenClaw";
    const body = normalizeTrimmedString(params.body) ?? "Web push test notification";

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
      respond(true, { results }, undefined);
    });
  },
};
