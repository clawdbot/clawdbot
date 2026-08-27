import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  ErrorCodes,
  errorShape,
  validateScopeUpgradeRequest,
  validateScopeUpgradeWait,
} from "../../../packages/gateway-protocol/src/index.js";
import { getPairedDevice, requestDevicePairing } from "../../infra/device-pairing.js";
import { normalizeDeviceAuthScopes } from "../../shared/device-auth.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { resolveOperatorRolePolicy } from "../operator-role-policy.js";
import { isOperatorScope } from "../operator-scopes.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEVICE_REQUIRED_MESSAGE =
  "device scope upgrade requires a paired browser identity; reopen the Control UI over HTTPS or localhost, then retry";

function readUpgradeOwner(client: GatewayClient | null): {
  deviceId: string;
  publicKey: string;
} | null {
  const deviceId = client?.connect.device?.id.trim();
  const publicKey = client?.connect.device?.publicKey.trim();
  return client?.connId && client.connect.role === "operator" && deviceId && publicKey
    ? { deviceId, publicKey }
    : null;
}

function respondDeviceRequired(respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_REQUIRED_MESSAGE, {
      details: {
        code: ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED,
        recommendedNextStep: "reopen_control_ui_securely",
      },
    }),
  );
}

/** Live operator scope-upgrade request and identity-bound wait handlers. */
export const scopeUpgradeHandlers: GatewayRequestHandlers = {
  "device.scopes.requestUpgrade": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(
        params,
        validateScopeUpgradeRequest,
        "device.scopes.requestUpgrade",
        respond,
      )
    ) {
      return;
    }
    const owner = readUpgradeOwner(client);
    if (!owner) {
      respondDeviceRequired(respond);
      return;
    }
    const paired = await getPairedDevice(owner.deviceId);
    if (!paired || paired.publicKey !== owner.publicKey) {
      respondDeviceRequired(respond);
      return;
    }
    const requestedScopes = normalizeDeviceAuthScopes((params as { scopes: string[] }).scopes);
    if (!requestedScopes.every(isOperatorScope)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "requested scopes contain an unknown operator scope",
        ),
      );
      return;
    }
    const rolePolicy = resolveOperatorRolePolicy(client, context.getRuntimeConfig());
    if (rolePolicy && requestedScopes.some((scope) => !rolePolicy.scopes.includes(scope))) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "requested scopes exceed your assigned operator role; ask a gateway administrator to change your role",
        ),
      );
      return;
    }
    const currentScopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
    if (
      !roleScopesAllow({
        role: "operator",
        requestedScopes: currentScopes,
        allowedScopes: requestedScopes,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "requested scopes must include the connection's current scopes",
        ),
      );
      return;
    }
    const pairing = await requestDevicePairing({
      deviceId: owner.deviceId,
      publicKey: owner.publicKey,
      displayName: client?.connect.client.displayName,
      platform: client?.connect.client.platform,
      deviceFamily: client?.connect.client.deviceFamily,
      clientId: client?.connect.client.id,
      clientMode: client?.connect.client.mode,
      browserOrigin: paired.browserOrigin,
      role: "operator",
      scopes: requestedScopes,
      remoteIp: client?.clientIp,
      silent: false,
    });
    const coordinator = context.scopeUpgradeCoordinator;
    if (
      !coordinator?.register({
        requestId: pairing.request.requestId,
        expiresAtMs: pairing.expiresAtMs,
        owner,
        requestedScopes,
        initialToken: paired.tokens?.operator?.token,
        initialApprovedAtMs: paired.approvedAtMs,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "device scope upgrade is temporarily unavailable", {
          retryable: true,
        }),
      );
      return;
    }
    const resolvedAt = Date.now();
    for (const superseded of pairing.superseded ?? []) {
      coordinator.notify(superseded.requestId, "rejected");
      context.broadcast(
        "device.pair.resolved",
        {
          requestId: superseded.requestId,
          deviceId: superseded.deviceId,
          decision: "rejected",
          ts: resolvedAt,
        },
        { dropIfSlow: true },
      );
    }
    if (pairing.created) {
      context.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
    }
    context.logGateway.warn(
      `security audit: live device scope upgrade requested device=${owner.deviceId} scopesFrom=${currentScopes.join(",")} scopesTo=${requestedScopes.join(",")}`,
    );
    respond(true, { requestId: pairing.request.requestId }, undefined);
  },

  "device.scopes.waitUpgrade": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(params, validateScopeUpgradeWait, "device.scopes.waitUpgrade", respond)
    ) {
      return;
    }
    const owner = readUpgradeOwner(client);
    if (!owner) {
      respondDeviceRequired(respond);
      return;
    }
    const requestId = (params as { requestId: string }).requestId;
    const result = await context.scopeUpgradeCoordinator?.wait(requestId, owner);
    if (!result) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "scope upgrade expired or not found"),
      );
      return;
    }
    if (result.status === "approved") {
      const rolePolicy = resolveOperatorRolePolicy(client, context.getRuntimeConfig());
      if (
        rolePolicy &&
        result.scopes.some(
          (scope) => !rolePolicy.scopes.some((allowedScope) => allowedScope === scope),
        )
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "approved scopes exceed your assigned operator role; ask a gateway administrator to change your role",
          ),
        );
        return;
      }
    }
    respond(true, result, undefined);
  },
};
