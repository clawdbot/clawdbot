import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  coerceSecretRef,
  normalizeSecretInputString,
  type SecretInput,
} from "../config/types.secrets.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { materializeSecretInput } from "../secrets/resolve-secret-input-string.js";

const CF_ACCESS_CLIENT_ID_ENV = "CF_ACCESS_CLIENT_ID";
const CF_ACCESS_CLIENT_SECRET_ENV = "CF_ACCESS_CLIENT_SECRET";

export type NodeHostCloudflareAccessConfig = {
  clientId: SecretInput;
  clientSecret: SecretInput;
};

function normalizeCloudflareAccessSecretInput(value: unknown, path: string): SecretInput {
  const ref = coerceSecretRef(value);
  if (ref) {
    return ref;
  }
  const literal = normalizeSecretInputString(value);
  if (literal) {
    return literal;
  }
  throw new Error(`invalid node-host ${path}: expected a non-empty SecretInput`);
}

export function normalizeNodeHostCloudflareAccessConfig(
  value: unknown,
): NodeHostCloudflareAccessConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !("clientId" in value) ||
    !("clientSecret" in value)
  ) {
    throw new Error(
      "invalid node-host gateway.cloudflareAccess: expected clientId and clientSecret",
    );
  }
  return {
    clientId: normalizeCloudflareAccessSecretInput(
      value.clientId,
      "gateway.cloudflareAccess.clientId",
    ),
    clientSecret: normalizeCloudflareAccessSecretInput(
      value.clientSecret,
      "gateway.cloudflareAccess.clientSecret",
    ),
  };
}

/** Persist conventional environment fallback as refs, never as copied plaintext. */
export function nodeHostCloudflareAccessConfigFromEnv(
  env: NodeJS.ProcessEnv,
): NodeHostCloudflareAccessConfig | undefined {
  const clientId = normalizeSecretInputString(env[CF_ACCESS_CLIENT_ID_ENV]);
  const clientSecret = normalizeSecretInputString(env[CF_ACCESS_CLIENT_SECRET_ENV]);
  if (!clientId && !clientSecret) {
    return undefined;
  }
  if (!clientId || !clientSecret) {
    throw new Error(
      `${CF_ACCESS_CLIENT_ID_ENV} and ${CF_ACCESS_CLIENT_SECRET_ENV} must be configured together`,
    );
  }
  return {
    clientId: { source: "env", provider: "default", id: CF_ACCESS_CLIENT_ID_ENV },
    clientSecret: { source: "env", provider: "default", id: CF_ACCESS_CLIENT_SECRET_ENV },
  };
}

export async function resolveNodeHostCloudflareAccess(params: {
  value?: NodeHostCloudflareAccessConfig;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<CloudflareAccessCredentials | undefined> {
  if (!params.value) {
    return undefined;
  }
  const [clientId, clientSecret] = await Promise.all([
    materializeSecretInput({
      config: params.config,
      value: params.value.clientId,
      env: params.env,
    }),
    materializeSecretInput({
      config: params.config,
      value: params.value.clientSecret,
      env: params.env,
    }),
  ]);
  if (!clientId || !clientSecret) {
    throw new Error("node-host Cloudflare Access credentials resolved empty");
  }
  registerSecretValueForRedaction(clientId);
  registerSecretValueForRedaction(clientSecret);
  return { clientId, clientSecret };
}

export function nodeHostGatewayMatchesUrl(
  gateway: { host?: string; port?: number; tls?: boolean },
  target: URL,
): boolean {
  const host = gateway.host ?? "127.0.0.1";
  const urlHost =
    host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host;
  const protocol = gateway.tls ? "https:" : "http:";
  const port = gateway.port ?? (gateway.tls ? 443 : 80);
  const configured = new URL(`${protocol}//${urlHost}:${port}`);
  return configured.protocol === target.protocol && configured.host === target.host;
}

export function nodeHostGatewaysShareOrigin(
  left: { host?: string; port?: number; tls?: boolean },
  right: { host?: string; port?: number; tls?: boolean },
): boolean {
  const host = right.host ?? "127.0.0.1";
  const urlHost =
    host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host;
  const protocol = right.tls ? "https:" : "http:";
  const port = right.port ?? (right.tls ? 443 : 80);
  return nodeHostGatewayMatchesUrl(left, new URL(`${protocol}//${urlHost}:${port}`));
}
