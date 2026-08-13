import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { classifyGatewayConnectFailure } from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { AgentsListResult } from "../../packages/gateway-protocol/src/index.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  callGateway,
  GatewayStoredDeviceAuthUnavailableError,
  GatewayTransportError,
} from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { projectGatewayUrlForDiagnostics } from "../gateway/connection-details.js";
import {
  parseSessionTargetInput,
  SessionTargetParseError,
  type SessionTargetInput,
} from "./session-ref.js";

export type SessionTargetGateway = {
  config?: OpenClawConfig;
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
};

type ResolvedSessionTarget = {
  sessionKey: string;
  gateway: SessionTargetGateway;
  parsed: SessionTargetInput;
};

type SessionsResolveResult =
  | { ok: true; key: string }
  | { ok: false; candidates?: Array<{ key: string; displayName?: string }> };

function gatewayUrlForTarget(target: SessionTargetInput): string | undefined {
  return target.kind === "url" ? `${target.origin}${target.basePath}` : undefined;
}

export async function callSessionTargetGateway<T>(params: {
  gateway: SessionTargetGateway;
  method: string;
  request?: unknown;
  requiredScope: "operator.read" | "operator.admin";
  shortRef?: boolean;
}): Promise<T> {
  const explicitUrl = params.gateway.url?.trim() || undefined;
  try {
    return await callGateway<T>({
      config: params.gateway.config,
      url: explicitUrl,
      token: params.gateway.token,
      password: params.gateway.password,
      tlsFingerprint: params.gateway.tlsFingerprint,
      method: params.method,
      params: params.request,
      mode: GATEWAY_CLIENT_MODES.CLI,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      ...(explicitUrl
        ? {
            useStoredDeviceAuth: true,
            requiredStoredDeviceAuthScopes: [params.requiredScope],
          }
        : {}),
    });
  } catch (error) {
    throw shapeTargetError(error, explicitUrl, params.shortRef === true);
  }
}

function candidateId(key: string): string {
  const uuid = key.match(/([0-9a-f]{8}-[0-9a-f-]{27})$/iu)?.[1]?.replaceAll("-", "");
  return (uuid ?? key).slice(0, 16);
}

function formatAmbiguousCandidates(
  candidates: Array<{ key: string; displayName?: string }>,
  gatewayUrl: string | undefined,
): string {
  const rows = candidates.map((candidate) => ({
    name: sanitizeTerminalText(candidate.displayName?.trim() || "(unnamed)")
      .replace(/\s+/gu, " ")
      .slice(0, 40),
    id: candidateId(candidate.key),
  }));
  const width = Math.max("SESSION".length, ...rows.map((row) => row.name.length));
  return [
    "Session reference is ambiguous:",
    `${"SESSION".padEnd(width)}  ID PREFIX`,
    ...rows.map((row) => `${row.name.padEnd(width)}  ${row.id}`),
    `Pass a longer reference. ${sessionsListHint(gatewayUrl)}`,
  ].join("\n");
}

function sessionsListHint(gatewayUrl: string | undefined): string {
  return gatewayUrl
    ? `Choose a full session key from that gateway's Control UI (${controlUiBaseUrl(gatewayUrl)}).`
    : "Run `openclaw sessions list` to choose a full session key.";
}

function controlUiBaseUrl(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  url.protocol =
    url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  return sanitizeTerminalText(url.toString().replace(/\/$/u, ""));
}

function isPriorGatewayShortIdRejection(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("invalid sessions.resolve params:") &&
    error.message.includes("unexpected property 'shortId'")
  );
}

function unreachableTargetError(error: Error, gatewayUrl: string | undefined): Error {
  if (!gatewayUrl) {
    return error;
  }
  const hostname = new URL(gatewayUrl).hostname;
  const displayGatewayUrl = projectGatewayUrlForDiagnostics(gatewayUrl);
  const tailscaleHint = hostname.endsWith(".ts.net")
    ? " For this .ts.net host, check that Tailscale is connected and the gateway is reachable on your tailnet."
    : "";
  return new Error(
    `${error.message}\nCould not reach gateway ${displayGatewayUrl}. Check whether the gateway is down and whether its tailnet or SSH tunnel is reachable.${tailscaleHint}`,
  );
}

function shapeTargetError(
  error: unknown,
  gatewayUrl: string | undefined,
  shortRef: boolean,
): Error {
  if (shortRef && isPriorGatewayShortIdRejection(error)) {
    return new Error(
      `This gateway predates short-link resolution; pass the full session key. ${sessionsListHint(gatewayUrl)}`,
    );
  }
  if (error instanceof GatewayStoredDeviceAuthUnavailableError && gatewayUrl) {
    return new Error(
      `No stored device auth for ${gatewayUrl}. Pass --token or --password once, approve the pairing request in that gateway's Control UI (Settings > Devices), then retry.`,
    );
  }
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  // A pin mismatch names the precise trust failure and must never be reclassified as transport.
  if (/tls fingerprint/iu.test(error.message)) {
    return error;
  }
  if (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("No session found")
  ) {
    return new Error(`${error.message}\n${sessionsListHint(gatewayUrl)}`);
  }
  const failure = classifyGatewayConnectFailure({
    ...(error instanceof GatewayClientRequestError ? { details: error.details } : {}),
    ...(error instanceof GatewayTransportError ? { reason: error.reason } : {}),
    message: error.message,
  });
  if (failure.kind === "unreachable") {
    const effectiveGatewayUrl =
      gatewayUrl ??
      (error instanceof GatewayTransportError ? error.connectionDetails.url : undefined);
    return unreachableTargetError(error, effectiveGatewayUrl);
  }
  return failure.remediation ? new Error(`${failure.userMessage}\n${failure.remediation}`) : error;
}

export async function resolveSessionTarget(params: {
  raw: string;
  gateway?: SessionTargetGateway;
  requiredScope?: "operator.read" | "operator.admin";
}): Promise<ResolvedSessionTarget> {
  const parsed = parseSessionTargetInput(params.raw);
  const targetUrl = gatewayUrlForTarget(parsed);
  if (targetUrl && params.gateway?.url) {
    throw new Error("pass one target: use either the session URL or --url, not both");
  }
  const gateway: SessionTargetGateway = {
    ...params.gateway,
    url: targetUrl ?? params.gateway?.url,
  };
  if (parsed.ref.kind === "main") {
    if (parsed.kind !== "url") {
      throw new SessionTargetParseError();
    }
    const agents = await callSessionTargetGateway<AgentsListResult>({
      gateway,
      method: "agents.list",
      request: {},
      requiredScope: params.requiredScope ?? "operator.read",
    });
    return {
      parsed,
      gateway,
      sessionKey: resolveCanonicalMainSessionKey({
        agentId: parsed.agentId,
        mainKey: agents.mainKey,
        sessionScope: agents.scope,
      }),
    };
  }

  const ref = parsed.ref;
  const request =
    ref.kind === "short"
      ? {
          shortId: ref.shortId,
          ...(ref.slugHint ? { slugHint: ref.slugHint } : {}),
        }
      : { key: ref.sessionKey };
  const result = await callSessionTargetGateway<SessionsResolveResult>({
    gateway,
    method: "sessions.resolve",
    request,
    requiredScope: params.requiredScope ?? "operator.read",
    shortRef: ref.kind === "short",
  });
  if (result.ok) {
    return { parsed, gateway, sessionKey: result.key };
  }
  if (result.candidates?.length) {
    throw new Error(formatAmbiguousCandidates(result.candidates, gateway.url));
  }
  throw new Error(`No session found.\n${sessionsListHint(gateway.url)}`);
}
