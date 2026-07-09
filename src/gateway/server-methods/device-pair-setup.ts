// Device-pairing setup-code method produces the connect QR/setup code a mobile
// or companion client scans to connect to this gateway. It reuses the same
// pairing helpers as `openclaw qr` so non-terminal clients can display the
// connect QR that was previously only renderable in a terminal.
import {
  ErrorCodes,
  errorShape,
  validateDevicePairSetupCodeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { renderQrPngDataUrl } from "../../media/qr-image.js";
import { encodePairingSetupCode, resolvePairingSetupFromConfig } from "../../pairing/setup-code.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../../shared/device-bootstrap-profile.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

// Keep the rendered QR within the result schema's qrDataUrl bound. A pathological
// publicUrl can produce a setup code whose QR PNG data URL exceeds the limit; in
// that case we omit the QR (the client can still render one from setupCode)
// rather than return a response that violates the protocol schema.
const MAX_QR_DATA_URL_LENGTH = 16_384;

function readConfiguredDevicePairPublicUrl(config: OpenClawConfig): string | undefined {
  const value = config.plugins?.entries?.["device-pair"]?.config?.["publicUrl"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    try {
      const config = context.getRuntimeConfig();
      const requestPublicUrl = typeof params.publicUrl === "string" ? params.publicUrl : undefined;
      const configuredPublicUrl =
        params.preferRemoteUrl === true ? undefined : readConfiguredDevicePairPublicUrl(config);
      const publicUrl = requestPublicUrl ?? configuredPublicUrl;
      const resolved = await resolvePairingSetupFromConfig(config, {
        env: process.env,
        publicUrl,
        preferRemoteUrl: params.preferRemoteUrl === true,
        ...(params.bootstrapProfile === "node"
          ? { bootstrapProfile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE }
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
          setupCode,
          ...(qrDataUrl ? { qrDataUrl } : {}),
          gatewayUrl: resolved.payload.url,
          ...(resolved.payload.urls ? { gatewayUrls: resolved.payload.urls } : {}),
          // Label only — never the raw gateway token/password.
          auth: resolved.authLabel,
          urlSource: requestPublicUrl ? "request.publicUrl" : resolved.urlSource,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
