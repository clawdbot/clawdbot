import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { aguiChannelPlugin } from "./channel.js";
import {
  createDeviceToken,
  sendJson,
  sendUnauthorized,
  verifyDeviceToken,
} from "./request-util.js";

/**
 * `ok: false` means a response has ALREADY been written (pairing challenge,
 * 401, 429, or 503) and the caller must simply return.
 */
export type DeviceAuthResult = { ok: true; deviceId: string } | { ok: false };

/**
 * Device-pairing authentication for the untrusted AG-UI route (`/v1/ag-ui`).
 *
 * No bearer token starts a pairing handshake: mint a device id, register a
 * pairing request, and hand back a signed token plus the code an owner approves
 * out of band. A presented token must verify by HMAC AND name a device the owner
 * has since approved.
 */
export async function authenticateAguiDevice(params: {
  req: IncomingMessage;
  res: ServerResponse;
  runtime: PluginRuntime;
  api: OpenClawPluginApi;
  gatewaySecret: string;
  bearerToken: string | undefined;
}): Promise<DeviceAuthResult> {
  const { req: _req, res, runtime, api, gatewaySecret, bearerToken } = params;

  if (!bearerToken) {
    const deviceId = randomUUID();
    const { code: pairingCode } = await runtime.channel.pairing.upsertPairingRequest({
      channel: "ag-ui",
      accountId: "default",
      id: deviceId,
      pairingAdapter: aguiChannelPlugin.pairing,
    });

    // No code means the pending-request cap is full.
    if (!pairingCode) {
      sendJson(res, 429, {
        error: {
          type: "rate_limit",
          message:
            "Too many pending pairing requests. Please wait for existing requests to expire (10 minutes) or ask the owner to approve/reject them.",
        },
      });
      return { ok: false };
    }

    const deviceToken = createDeviceToken(gatewaySecret, deviceId);
    sendJson(res, 403, {
      pairing_code: pairingCode,
      bearer_token: deviceToken,
      error: {
        type: "pairing_pending",
        message: "Device pending approval",
        pairing: {
          pairingCode,
          token: deviceToken,
          instructions: `Save this token for use as a Bearer token and ask the owner to approve: openclaw pairing approve ag-ui ${pairingCode}`,
        },
      },
    });
    return { ok: false };
  }

  const deviceId = verifyDeviceToken(bearerToken, gatewaySecret);
  if (!deviceId) {
    sendUnauthorized(res);
    return { ok: false };
  }

  // A store read that FAILS is not the same as a device that is not approved.
  // Collapsing the two into `[]` answered an operational fault with
  // "pairing_pending", telling an already-approved owner to approve again and
  // hiding the real repair action. Report the fault as retryable instead.
  let storeAllowFrom: string[];
  try {
    storeAllowFrom = await (
      runtime.channel.pairing.readAllowFromStore as unknown as (arg: {
        channel: string;
      }) => Promise<string[]>
    )({ channel: "ag-ui" });
  } catch (err) {
    api.logger?.error?.(`[ag-ui] pairing allow-list read failed: ${String(err)}`);
    sendJson(res, 503, {
      error: {
        type: "service_unavailable",
        message:
          "Could not read the device pairing list. This is a gateway storage fault, not a pairing problem — check the gateway logs and retry.",
      },
    });
    return { ok: false };
  }

  const normalizedAllowFrom = storeAllowFrom.map((e) => e.replace(/^ag-ui:/i, "").toLowerCase());
  if (!normalizedAllowFrom.includes(deviceId.toLowerCase())) {
    sendJson(res, 403, {
      error: {
        type: "pairing_pending",
        message:
          "Device pending approval. Ask the owner to approve using the pairing code from your initial pairing response.",
      },
    });
    return { ok: false };
  }

  return { ok: true, deviceId };
}
