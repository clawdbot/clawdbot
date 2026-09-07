// Gateway status probe helper used by `gateway status` service diagnostics.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { isGatewayProtocolResponseError } from "../../../packages/gateway-client/src/protocol-request.js";
import {
  classifyGatewayConnectFailure,
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from "../../../packages/gateway-protocol/src/connect-error-details.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { GatewayProbeAuthSummary, GatewayProbeServerSummary } from "../../gateway/probe.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { withProgress } from "../progress.js";

const probeGatewayModuleLoader = createLazyImportLoader(() => import("../../gateway/probe.js"));
const CONNECT_ERROR_DETAIL_CODE_VALUES: ReadonlySet<string> = new Set(
  Object.values(ConnectErrorDetailCodes),
);

function resolveProbeFailureMessage(result: {
  error?: string | null;
  close?: { code: number; reason: string } | null;
}): string {
  const closeHint = result.close
    ? `gateway closed (${result.close.code}): ${result.close.reason}`
    : null;
  if (closeHint && (!result.error || result.error === "timeout")) {
    return closeHint;
  }
  return result.error ?? closeHint ?? "gateway probe failed";
}

function projectGatewayConnectFailure(params: {
  details?: unknown;
  message: string;
  reason?: string;
}) {
  // Daemon status is serialized for diagnostics, so raw gateway details must
  // stop here; only closed classification facts may cross this boundary.
  const failure = classifyGatewayConnectFailure(params);
  const detailCode = readConnectErrorDetailCode(params.details);
  return {
    kind: failure.kind,
    ...(detailCode && CONNECT_ERROR_DETAIL_CODE_VALUES.has(detailCode) ? { detailCode } : {}),
  };
}

/** Probe Gateway connectivity or read-capability status with optional RPC verification. */
export async function probeGatewayStatus(opts: {
  url: string;
  urlOverride?: string;
  localPortOverride?: number;
  token?: string;
  password?: string;
  config?: OpenClawConfig;
  tlsFingerprint?: string;
  timeoutMs: number;
  preauthHandshakeTimeoutMs?: number;
  json?: boolean;
  requireRpc?: boolean;
  allowRpcConfigCredentials?: boolean;
  configPath?: string;
}) {
  const kind = opts.requireRpc ? "read" : "connect";
  let auth: GatewayProbeAuthSummary | undefined;
  let server: GatewayProbeServerSummary | undefined;
  let gatewayReached = false;
  try {
    const result = await withProgress(
      {
        label: "Checking gateway status...",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () => {
        if (opts.requireRpc) {
          const allowRpcConfigCredentials = opts.allowRpcConfigCredentials !== false;
          if (!allowRpcConfigCredentials && !opts.token && !opts.password) {
            throw new Error(
              "gateway status RPC skipped because configured gateway credentials are disabled for this status request",
            );
          }
          const { resolveProbeAuthSummary } = await probeGatewayModuleLoader.load();
          const { callGateway } = await import("../../gateway/call.js");
          await callGateway({
            ...(opts.urlOverride ? { url: opts.urlOverride } : { serviceTargetUrl: opts.url }),
            localPortOverride: opts.localPortOverride,
            token: opts.token,
            password: opts.password,
            tlsFingerprint: opts.tlsFingerprint,
            preauthHandshakeTimeoutMs: opts.preauthHandshakeTimeoutMs,
            ...(allowRpcConfigCredentials && opts.config ? { config: opts.config } : {}),
            method: "status",
            timeoutMs: opts.timeoutMs,
            sharedStateMode: "read-only",
            skipImplicitAuth: true,
            ...(opts.configPath ? { configPath: opts.configPath } : {}),
            onHelloOk: (hello) => {
              gatewayReached = true;
              auth = resolveProbeAuthSummary({
                role: hello.auth.role,
                scopes: hello.auth.scopes,
                authMetadataPresent: true,
              });
              server = hello.server;
            },
          });
          return { ok: true as const, auth, server };
        }
        const { probeGateway } = await probeGatewayModuleLoader.load();
        return await probeGateway({
          url: opts.url,
          ...(opts.config ? { config: opts.config } : {}),
          auth: {
            token: opts.token,
            password: opts.password,
          },
          tlsFingerprint: opts.tlsFingerprint,
          ...(opts.preauthHandshakeTimeoutMs !== undefined
            ? { preauthHandshakeTimeoutMs: opts.preauthHandshakeTimeoutMs }
            : {}),
          timeoutMs: opts.timeoutMs,
          includeDetails: false,
        });
      },
    );
    auth = result.auth;
    server = result.server;
    const serverSummary = server ? { server } : {};
    const version = server?.version ?? null;
    if (result.ok) {
      return {
        ok: true,
        kind,
        capability:
          kind === "read"
            ? auth?.capability && auth.capability !== "unknown"
              ? auth.capability
              : "read_only"
            : auth?.capability,
        auth,
        ...serverSummary,
        ...(version != null ? { version } : {}),
      } as const;
    }
    const error = redactSensitiveUrlLikeString(resolveProbeFailureMessage(result));
    return {
      ok: false,
      kind,
      ...(result.gatewayReached ? { gatewayReached: true as const } : {}),
      capability: auth?.capability,
      auth,
      ...serverSummary,
      ...(version != null ? { version } : {}),
      connectFailure: projectGatewayConnectFailure({
        details: result.connectErrorDetails,
        message: error,
        reason: result.close?.reason,
      }),
      // Probe failure text can echo the credential-bearing target URL (close
      // reasons, transport errors); status renderers print it verbatim.
      error,
    } as const;
  } catch (err) {
    const error = redactSensitiveUrlLikeString(formatErrorMessage(err));
    return {
      ok: false,
      kind,
      ...(gatewayReached || isGatewayProtocolResponseError(err)
        ? { gatewayReached: true as const }
        : {}),
      ...(auth ? { auth, capability: auth.capability } : {}),
      ...(server ? { server, ...(server.version != null ? { version: server.version } : {}) } : {}),
      connectFailure: projectGatewayConnectFailure({
        message: error,
        ...(isGatewayProtocolResponseError(err) ? { details: err.details } : {}),
      }),
      error,
    } as const;
  }
}
