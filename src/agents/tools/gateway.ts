/**
 * Gateway call helpers for built-in tools.
 *
 * Resolves gateway URL/token overrides, local credentials, and least-privilege operator scopes.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { getRuntimeConfig, resolveGatewayPort } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { resolveGatewayCredentialsFromConfig, trimToUndefined } from "../../gateway/credentials.js";
import {
  resolveLeastPrivilegeOperatorScopesForMethod,
  type OperatorScope,
} from "../../gateway/method-scopes.js";
import { getOperatorApprovalRuntimeToken } from "../../gateway/operator-approval-runtime-token.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from "../../infra/device-identity.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPositiveIntegerParam, readStringParam } from "./common.js";

export const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

/** Optional gateway connection overrides accepted by agent tools. */
export type GatewayCallOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
};

type GatewayOverrideTarget = "local" | "remote";

/** Reads common gateway options from tool parameters while preserving explicit token whitespace. */
export function readGatewayCallOptions(params: Record<string, unknown>): GatewayCallOptions {
  return {
    gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
    gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
    timeoutMs: readPositiveIntegerParam(params, "timeoutMs"),
  };
}

/**
 * Canonicalizes websocket URLs for allowlist comparisons without retaining paths or credentials.
 */
function canonicalizeToolGatewayWsUrl(raw: string): { origin: string; key: string } {
  const input = raw.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    const message = formatErrorMessage(error);
    throw new Error(`invalid gatewayUrl: ${input} (${message})`, { cause: error });
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`invalid gatewayUrl protocol: ${url.protocol} (expected ws:// or wss://)`);
  }
  if (url.username || url.password) {
    throw new Error("invalid gatewayUrl: credentials are not allowed");
  }
  if (url.search || url.hash) {
    throw new Error("invalid gatewayUrl: query/hash not allowed");
  }
  // Agents/tools expect the gateway websocket on the origin, not arbitrary paths.
  if (url.pathname && url.pathname !== "/") {
    throw new Error("invalid gatewayUrl: path not allowed");
  }

  const origin = url.origin;
  // Key: protocol + host only, lowercased. (host includes IPv6 brackets + port when present)
  const key = `${url.protocol}//${normalizeLowercaseStringOrEmpty(url.host)}`;
  return { origin, key };
}

function resolveLocalGatewayUrlKeys(cfg: OpenClawConfig): Set<string> {
  const port = resolveGatewayPort(cfg);
  return new Set<string>([
    `ws://127.0.0.1:${port}`,
    `wss://127.0.0.1:${port}`,
    `ws://localhost:${port}`,
    `wss://localhost:${port}`,
    `ws://[::1]:${port}`,
    `wss://[::1]:${port}`,
  ]);
}

function resolveConfiguredRemoteGatewayKey(cfg: OpenClawConfig): string | undefined {
  let remoteKey: string | undefined;
  const remoteUrl = normalizeOptionalString(cfg.gateway?.remote?.url) ?? "";
  if (remoteUrl) {
    try {
      const remote = canonicalizeToolGatewayWsUrl(remoteUrl);
      remoteKey = remote.key;
    } catch {
      // Misconfigured remote URL should not make ordinary tool calls fail; only explicit
      // gatewayUrl overrides need strict validation.
    }
  }
  return remoteKey;
}

function resolveDefaultGatewayTarget(params: {
  cfg: OpenClawConfig;
  envGatewayUrl?: string;
}): GatewayOverrideTarget {
  if (params.envGatewayUrl) {
    // Match operator-approvals-client: env-selected URLs may be tunnels or other gateways,
    // so loopback alone must not grant local approval-runtime authority.
    return "remote";
  }
  if (
    params.cfg.gateway?.mode === "remote" &&
    normalizeOptionalString(params.cfg.gateway.remote?.url)
  ) {
    return "remote";
  }
  return "local";
}

function validateGatewayUrlOverrideForAgentTools(params: {
  cfg: OpenClawConfig;
  urlOverride: string;
}): { url: string; target: GatewayOverrideTarget } {
  const { cfg } = params;
  const localAllowed = resolveLocalGatewayUrlKeys(cfg);
  const remoteKey = resolveConfiguredRemoteGatewayKey(cfg);

  const parsed = canonicalizeToolGatewayWsUrl(params.urlOverride);
  if (localAllowed.has(parsed.key)) {
    return { url: parsed.origin, target: "local" };
  }
  if (remoteKey && parsed.key === remoteKey) {
    return { url: parsed.origin, target: "remote" };
  }
  const port = resolveGatewayPort(cfg);
  throw new Error(
    [
      "gatewayUrl override rejected.",
      `Allowed: ws(s) loopback on port ${port} (127.0.0.1/localhost/[::1])`,
      "Or: configure gateway.remote.url and omit gatewayUrl to use the configured remote gateway.",
    ].join(" "),
  );
}

function resolveGatewayOverrideToken(params: {
  cfg: OpenClawConfig;
  target: GatewayOverrideTarget;
  explicitToken?: string;
}): string | undefined {
  if (params.explicitToken) {
    return params.explicitToken;
  }
  return resolveGatewayCredentialsFromConfig({
    cfg: params.cfg,
    env: process.env,
    modeOverride: params.target,
    remoteTokenFallback: params.target === "remote" ? "remote-only" : "remote-env-local",
    remotePasswordFallback: params.target === "remote" ? "remote-only" : "remote-env-local",
  }).token;
}

/**
 * Resolves the gateway URL, token, and timeout for agent tool calls.
 */
export function resolveGatewayOptions(opts?: GatewayCallOptions) {
  const cfg = getRuntimeConfig();
  const validatedOverride =
    trimToUndefined(opts?.gatewayUrl) !== undefined
      ? validateGatewayUrlOverrideForAgentTools({
          cfg,
          urlOverride: String(opts?.gatewayUrl),
        })
      : undefined;
  const explicitToken = trimToUndefined(opts?.gatewayToken);
  const token = validatedOverride
    ? resolveGatewayOverrideToken({
        cfg,
        target: validatedOverride.target,
        explicitToken,
      })
    : explicitToken;
  const timeoutMs =
    typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Math.floor(opts.timeoutMs))
      : 30_000;
  const envGatewayUrl = trimToUndefined(process.env.OPENCLAW_GATEWAY_URL);
  const target =
    validatedOverride?.target ??
    resolveDefaultGatewayTarget({
      cfg,
      envGatewayUrl,
    });
  return { url: validatedOverride?.url, token, timeoutMs, target };
}

const APPROVAL_RUNTIME_METHODS = new Set<string>([
  "exec.approval.request",
  "exec.approval.resolve",
  "exec.approval.waitDecision",
  "plugin.approval.request",
  "plugin.approval.waitDecision",
]);

function resolveApprovalRuntimeTokenForGatewayTool(params: {
  method: string;
  opts: GatewayCallOptions;
  target: GatewayOverrideTarget;
}): string | undefined {
  if (!APPROVAL_RUNTIME_METHODS.has(params.method)) {
    return undefined;
  }
  if (trimToUndefined(params.opts.gatewayUrl) !== undefined) {
    // Runtime approval tokens are scoped to the local approval bridge, not arbitrary
    // caller-supplied gateway URLs.
    return undefined;
  }
  if (params.target !== "local") {
    return undefined;
  }
  return getOperatorApprovalRuntimeToken();
}

function resolveApprovalRequesterDeviceIdentityForGatewayTool(params: {
  method: string;
  opts: GatewayCallOptions;
  target: GatewayOverrideTarget;
}): DeviceIdentity | undefined {
  if (!APPROVAL_RUNTIME_METHODS.has(params.method)) {
    return undefined;
  }
  if (trimToUndefined(params.opts.gatewayUrl) !== undefined) {
    return undefined;
  }
  if (params.target !== "remote") {
    return undefined;
  }
  try {
    const identity = loadOrCreateDeviceIdentity();
    // Remote approval requests are later matched by requester device id.
    // Reject loadOrCreate's unpersisted fallback so another process can see the same id.
    const persistedIdentity = loadDeviceIdentityIfPresent();
    if (persistedIdentity?.deviceId !== identity.deviceId) {
      throw new Error("device identity is not persisted");
    }
    return identity;
  } catch (error) {
    throw new Error(
      [
        "remote approval gateway calls require a stable device identity.",
        "Fix the OpenClaw state directory permissions or use the local approval-runtime gateway.",
      ].join(" "),
      { cause: error },
    );
  }
}

/**
 * Calls a gateway method as the agent-tool backend client with least-privilege scopes.
 */
export async function callGatewayTool<T = Record<string, unknown>>(
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: { expectFinal?: boolean; scopes?: OperatorScope[] },
) {
  const gateway = resolveGatewayOptions(opts);
  const scopes = Array.isArray(extra?.scopes)
    ? extra.scopes
    : resolveLeastPrivilegeOperatorScopesForMethod(method, params);
  const approvalRuntimeToken = resolveApprovalRuntimeTokenForGatewayTool({
    method,
    opts,
    target: gateway.target,
  });
  const deviceIdentity = resolveApprovalRequesterDeviceIdentityForGatewayTool({
    method,
    opts,
    target: gateway.target,
  });
  return await callGateway<T>({
    url: gateway.url,
    token: gateway.token,
    method,
    params,
    timeoutMs: gateway.timeoutMs,
    expectFinal: extra?.expectFinal,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "agent",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    ...(approvalRuntimeToken ? { approvalRuntimeToken } : {}),
    ...(deviceIdentity ? { deviceIdentity } : {}),
    scopes,
  });
}
