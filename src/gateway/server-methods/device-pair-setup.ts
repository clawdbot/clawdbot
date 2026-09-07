// Device-pairing setup-code method produces the connect QR/setup code a mobile
// or companion client scans to connect to this gateway. It reuses the same
// pairing helpers as `openclaw qr` so non-terminal clients can display the
// connect QR that was previously only renderable in a terminal.
import {
  ErrorCodes,
  errorShape,
  validateDevicePairSetupCodeParams,
  validateDevicePairSetupStatusParams,
  type DevicePairSetupStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { readDevicePairSetupCompletion } from "../../infra/device-bootstrap.js";
import { registerDevicePairingJoinCode } from "../../infra/device-pairing-join-code.js";
import { renderQrPngDataUrl } from "../../media/qr-image.js";
import {
  decodePairingSetupCode,
  encodePairingSetupCode,
  resolveConfiguredPairingPublicUrl,
  resolvePairingSetupFromConfig,
} from "../../pairing/setup-code.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../../shared/device-bootstrap-profile.js";
import { isLoopbackHost } from "../net.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

// Keep the rendered QR within the result schema's qrDataUrl bound. A pathological
// publicUrl can produce a setup code whose QR PNG data URL exceeds the limit; in
// that case we omit the QR (the client can still render one from setupCode)
// rather than return a response that violates the protocol schema.
const MAX_QR_DATA_URL_LENGTH = 16_384;
type PairingSetupPayload = ReturnType<typeof decodePairingSetupCode>;

function resolveDevicePairingJoinBaseUrl(payload: PairingSetupPayload): URL {
  for (const candidate of payload.urls ?? [payload.url]) {
    const parsed = new URL(candidate);
    if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
      return parsed;
    }
    if (parsed.protocol === "ws:" && isLoopbackHost(parsed.hostname)) {
      parsed.protocol = "http:";
      return parsed;
    }
  }
  throw new Error(
    "Join URLs require a TLS gateway endpoint, except for loopback. Use the setup code directly for plaintext LAN pairing.",
  );
}

/** Gateway handler for producing a device-pairing setup code + connect QR. */
export const devicePairSetupHandlers: GatewayRequestHandlers = {
  "device.pair.setupCode": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateDevicePairSetupCodeParams,
        "device.pair.setupCode",
        respond,
      )
    ) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      if (
        params.joinUrl === true &&
        params.bootstrapProfile !== undefined &&
        params.bootstrapProfile !== "node"
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Join URLs require bootstrapProfile=node."),
        );
        return;
      }
      const config = context.getRuntimeConfig();
      const requestPublicUrl = typeof params.publicUrl === "string" ? params.publicUrl : undefined;
      const configuredPublicUrl =
        params.preferRemoteUrl === true ? undefined : resolveConfiguredPairingPublicUrl(config);
      const publicUrl = requestPublicUrl ?? configuredPublicUrl;
      const resolved = await resolvePairingSetupFromConfig(config, {
        env: process.env,
        publicUrl,
        preferRemoteUrl: params.preferRemoteUrl === true,
        localTlsFingerprint: context.gatewayTlsFingerprint,
        ...(params.joinUrl === true || params.bootstrapProfile
          ? {
              bootstrapProfile:
                params.joinUrl === true || params.bootstrapProfile === "node"
                  ? NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE
                  : params.bootstrapProfile === "voice-node"
                    ? VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE
                    : PAIRING_SETUP_BOOTSTRAP_PROFILE,
            }
          : {}),
        // Lets Tailscale serve/funnel URLs resolve, mirroring the `openclaw qr` CLI.
        runCommandWithTimeout: async (argv, runOpts) =>
          await runCommandWithTimeout(argv, { timeoutMs: runOpts.timeoutMs }),
      });
      if (!resolved.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
        return;
      }
      const setupCode = encodePairingSetupCode(resolved.payload);
      let joinUrl: string | undefined;
      if (params.joinUrl === true) {
        const parsedJoinUrl = resolveDevicePairingJoinBaseUrl(resolved.payload);
        const shortcode = registerDevicePairingJoinCode({
          payload: resolved.payload,
          expiresAtMs: resolved.expiresAtMs,
        });
        const basePath = parsedJoinUrl.pathname.replace(/\/+$/u, "");
        parsedJoinUrl.pathname = `${basePath}/j/${shortcode}`;
        parsedJoinUrl.search = "";
        parsedJoinUrl.hash = "";
        joinUrl = parsedJoinUrl.toString();
      }
      // QR is on by default; callers that only need the code can opt out.
      const includeQr = params.includeQr !== false;
      // QR rendering is optional output; keep the usable setup code if encoding fails.
      const renderedQr = includeQr
        ? await renderQrPngDataUrl(setupCode).catch(() => undefined)
        : undefined;
      const qrDataUrl =
        renderedQr && renderedQr.length <= MAX_QR_DATA_URL_LENGTH ? renderedQr : undefined;
      respond(
        true,
        {
          setupId: resolved.setupId,
          expiresAtMs: resolved.expiresAtMs,
          setupCode,
          ...(joinUrl ? { joinUrl } : {}),
          ...(qrDataUrl ? { qrDataUrl } : {}),
          gatewayUrl: resolved.payload.url,
          ...(resolved.payload.urls ? { gatewayUrls: resolved.payload.urls } : {}),
          // Label only — never the raw gateway token/password.
          auth: resolved.authLabel,
          urlSource: requestPublicUrl ? "request.publicUrl" : resolved.urlSource,
          access: resolved.access,
          ...(resolved.accessDowngraded ? { accessDowngraded: true } : {}),
        },
        undefined,
      );
    });
  },
  // Recovery path for the best-effort device.pair.setup.completed broadcast: a
  // client that missed the frame must not present a redeemed setup as expired.
  "device.pair.setupStatus": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateDevicePairSetupStatusParams,
        "device.pair.setupStatus",
        respond,
      )
    ) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const completion = await readDevicePairSetupCompletion({ setupId: params.setupId });
      // Retention bookkeeping stays server-side; the wire shape matches the
      // corresponding success or delivery-uncertain broadcast.
      const result: DevicePairSetupStatusResult = completion
        ? (() => {
            const payload = {
              setupId: completion.setupId,
              deviceId: completion.deviceId,
              ...(completion.deviceName ? { deviceName: completion.deviceName } : {}),
              access: completion.access,
              ts: completion.completedAtMs,
            };
            return completion.deliveryState === "confirmed"
              ? { completion: payload }
              : { deliveryUncertain: payload };
          })()
        : {};
      respond(true, result, undefined);
    });
  },
};
