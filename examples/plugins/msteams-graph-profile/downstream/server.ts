import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { ConfidentialClientApplication } from "@azure/msal-node";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

type DownstreamConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  audience: string;
  requiredScope: string;
  graphScopes: string[];
  host: string;
  port: number;
};

type GraphMeResponse = {
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4010;
const DEFAULT_REQUIRED_SCOPE = "downstream.access";
const DEFAULT_GRAPH_SCOPE = "https://graph.microsoft.com/User.Read";
const GRAPH_ME_URL =
  "https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName";

const config = loadConfig(process.env);
const msal = new ConfidentialClientApplication({
  auth: {
    authority: `https://login.microsoftonline.com/${config.tenantId}`,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  },
});
const jwks = createRemoteJWKSet(
  new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`),
);

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (error) {
    console.error("[msteams-obo-downstream] request failed", redactError(error));
    sendJson(res, 500, { error: "internal_error" });
  }
});

server.listen(config.port, config.host, () => {
  console.log(
    `[msteams-obo-downstream] listening on http://${config.host}:${config.port} audience=${config.audience} scope=${config.requiredScope}`,
  );
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== "GET" || url.pathname !== "/api/me") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  const inboundToken = readBearerToken(req.headers.authorization);
  if (!inboundToken) {
    sendJson(res, 401, { error: "missing_bearer" });
    return;
  }

  const payload = await verifyInboundToken(inboundToken);
  if (!payload.ok) {
    sendJson(res, 401, { error: payload.error });
    return;
  }

  const graphToken = await acquireGraphToken(inboundToken);
  if (!graphToken.ok) {
    console.error("[msteams-obo-downstream] Graph OBO failed", graphToken.error);
    sendJson(res, graphToken.status, { error: graphToken.error });
    return;
  }

  const profile = await fetchGraphProfile(graphToken.accessToken);
  if (!profile.ok) {
    sendJson(res, profile.status, { error: "graph_profile_failed" });
    return;
  }

  console.log("[msteams-obo-downstream] profile resolved", {
    tenantId: payload.claims.tid,
    userId: payload.claims.oid ?? payload.claims.sub,
  });
  sendJson(res, 200, {
    displayName: profile.value.displayName ?? "unknown",
    email: profile.value.mail ?? profile.value.userPrincipalName ?? "unknown",
    userPrincipalName: profile.value.userPrincipalName ?? null,
  });
}

async function verifyInboundToken(
  token: string,
): Promise<{ ok: true; claims: JWTPayload } | { ok: false; error: string }> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience: expandAcceptedAudiences(config.audience),
      issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
    });
    if (payload.tid !== config.tenantId) {
      return { ok: false, error: "wrong_tenant" };
    }
    const scopes = readScopes(payload.scp);
    if (!scopes.has(config.requiredScope)) {
      return { ok: false, error: "missing_scope" };
    }
    return { ok: true, claims: payload };
  } catch {
    return { ok: false, error: "invalid_token" };
  }
}

async function acquireGraphToken(
  inboundToken: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; status: number; error: string }> {
  try {
    const result = await msal.acquireTokenOnBehalfOf({
      oboAssertion: inboundToken,
      scopes: config.graphScopes,
    });
    if (!result?.accessToken) {
      return { ok: false, status: 502, error: "graph_obo_failed" };
    }
    return { ok: true, accessToken: result.accessToken };
  } catch (error) {
    if (isConsentRequiredError(error)) {
      return { ok: false, status: 403, error: "graph_consent_required" };
    }
    throw error;
  }
}

async function fetchGraphProfile(
  accessToken: string,
): Promise<{ ok: true; value: GraphMeResponse } | { ok: false; status: number }> {
  const response = await fetch(GRAPH_ME_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  return { ok: true, value: (await response.json()) as GraphMeResponse };
}

function loadConfig(env: NodeJS.ProcessEnv): DownstreamConfig {
  const tenantId = readRequiredEnv(env, "MSTEAMS_OBO_TENANT_ID");
  const clientId = readRequiredEnv(env, "MSTEAMS_OBO_DOWNSTREAM_CLIENT_ID");
  const clientSecret = readRequiredEnv(env, "MSTEAMS_OBO_DOWNSTREAM_CLIENT_SECRET");
  const audience = readOptionalEnv(env, "MSTEAMS_OBO_AUDIENCE") ?? clientId;
  const requiredScope = readOptionalEnv(env, "MSTEAMS_OBO_SCOPE") ?? DEFAULT_REQUIRED_SCOPE;
  const graphScopes = (readOptionalEnv(env, "MSTEAMS_OBO_GRAPH_SCOPES") ?? DEFAULT_GRAPH_SCOPE)
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return {
    tenantId,
    clientId,
    clientSecret,
    audience,
    requiredScope,
    graphScopes,
    host: readOptionalEnv(env, "MSTEAMS_OBO_HOST") ?? DEFAULT_HOST,
    port: readPort(readOptionalEnv(env, "MSTEAMS_OBO_PORT")),
  };
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = readOptionalEnv(env, name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readOptionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function readPort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MSTEAMS_OBO_PORT must be a TCP port, got ${value}`);
  }
  return port;
}

function readBearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function readScopes(value: unknown): Set<string> {
  return new Set(typeof value === "string" ? value.split(/\s+/).filter(Boolean) : []);
}

function expandAcceptedAudiences(audience: string): string[] {
  const values = new Set([audience]);
  const appId = parseApiSchemeAppId(audience);
  if (appId) {
    values.add(appId);
  } else if (isPlainAppId(audience)) {
    values.add(`api://${audience.trim()}`);
  }
  return [...values];
}

function parseApiSchemeAppId(value: string): string | undefined {
  const match = /^api:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    value.trim(),
  );
  return match?.[1];
}

function isPlainAppId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function isConsentRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("AADSTS65001");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer <redacted>");
}
