/**
 * Auth-profile backed bearer injection for remote MCP servers.
 */
import crypto from "node:crypto";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpConfig, BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import { resolveApiKeyForProfile } from "./auth-profiles/oauth.js";
import { loadAuthProfileStoreForSecretsRuntime } from "./auth-profiles/store.js";
import {
  buildMcpHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
} from "./mcp-http-fetch.js";
import { resolveMcpOAuthAccessToken, type McpOAuthConfig } from "./mcp-oauth.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

type McpAuthProfileOptions = {
  cfg?: OpenClawConfig;
  agentDir?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function withoutAuthorizationHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() !== "authorization");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeStringHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Returns the refresh-capable auth profile selected for one MCP server. */
export function resolveMcpAuthProfileId(rawServer: unknown): string | undefined {
  if (!isRecord(rawServer) || rawServer.auth !== "oauth" || !isRecord(rawServer.oauth)) {
    return undefined;
  }
  const authProfileId = rawServer.oauth.authProfileId;
  return typeof authProfileId === "string" && authProfileId.trim().length > 0
    ? authProfileId.trim()
    : undefined;
}

/** Returns whether a server needs an OpenClaw-managed bearer projected externally. */
export function requiresMcpBearerProjection(rawServer: unknown): boolean {
  if (!isRecord(rawServer) || rawServer.auth !== "oauth") {
    return false;
  }
  return Boolean(resolveMcpAuthProfileId(rawServer) || typeof rawServer.url === "string");
}

async function resolveMcpAuthProfileBearerToken(
  params: {
    serverName: string;
    profileId: string;
  } & McpAuthProfileOptions,
): Promise<string> {
  const store = loadAuthProfileStoreForSecretsRuntime(params.agentDir, {
    config: params.cfg,
    externalCliProfileIds: [params.profileId],
  });
  const credential = store.profiles[params.profileId];
  if (!credential) {
    throw new Error(
      `MCP server "${params.serverName}" references auth profile "${params.profileId}", but that profile was not found.`,
    );
  }
  if (credential.type !== "oauth") {
    throw new Error(
      `MCP server "${params.serverName}" references auth profile "${params.profileId}", but ${credential.type} profiles are not refreshable. Use a refresh-capable OAuth profile.`,
    );
  }
  const resolved = await resolveApiKeyForProfile({
    cfg: params.cfg,
    store,
    profileId: params.profileId,
    agentDir: params.agentDir,
  });
  if (!resolved || resolved.profileType !== "oauth" || !resolved.apiKey) {
    throw new Error(
      `MCP server "${params.serverName}" could not resolve refreshable OAuth auth profile "${params.profileId}". Re-authenticate the profile and retry.`,
    );
  }
  if (
    !resolved.credential ||
    resolved.credential.type !== "oauth" ||
    typeof resolved.credential.access !== "string" ||
    resolved.credential.access.trim().length === 0
  ) {
    throw new Error(
      `MCP server "${params.serverName}" resolved OAuth auth profile "${params.profileId}", but no raw access token was available for bearer projection.`,
    );
  }
  return resolved.credential.access;
}

async function resolveMcpBearerToken(params: {
  serverName: string;
  server: BundleMcpServerConfig;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Promise<string | undefined> {
  const authProfileId = resolveMcpAuthProfileId(params.server);
  if (authProfileId) {
    return await resolveMcpAuthProfileBearerToken({
      serverName: params.serverName,
      profileId: authProfileId,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
  }
  if (params.server.auth !== "oauth") {
    return undefined;
  }
  const resolved = resolveMcpTransportConfig(params.serverName, params.server);
  if (!resolved || resolved.kind !== "http") {
    return undefined;
  }
  const fetchFn = withSameOriginMcpHttpHeaders({
    fetchFn: buildMcpHttpFetch({
      sslVerify: resolved.sslVerify,
      clientCert: resolved.clientCert,
      clientKey: resolved.clientKey,
      resourceUrl: resolved.url,
    }),
    headers: withoutMcpAuthorizationHeader(resolved.headers),
    resourceUrl: resolved.url,
  });
  return await resolveMcpOAuthAccessToken({
    serverName: params.serverName,
    serverUrl: resolved.url,
    config: resolved.oauth as McpOAuthConfig | undefined,
    fetchFn,
  });
}

/** Wraps HTTP MCP fetch with same-origin, refreshed bearer injection. */
export function withMcpAuthProfileBearer(
  params: {
    fetchFn: FetchLike;
    serverName: string;
    resourceUrl: string;
    headers?: Record<string, string>;
    authProfileId: string;
  } & McpAuthProfileOptions,
): FetchLike {
  const resourceOrigin = new URL(params.resourceUrl).origin;
  const configuredHeaders = withoutAuthorizationHeader(params.headers);
  return async (url, init) => {
    if (new URL(url).origin !== resourceOrigin) {
      return params.fetchFn(url, init);
    }
    const headers = new Headers(configuredHeaders);
    for (const [key, value] of new Headers(init?.headers)) {
      if (key.toLowerCase() !== "authorization") {
        headers.set(key, value);
      }
    }
    const token = await resolveMcpAuthProfileBearerToken({
      serverName: params.serverName,
      profileId: params.authProfileId,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    headers.set("authorization", `Bearer ${token}`);
    return params.fetchFn(url, { ...(init as RequestInit), headers });
  };
}

function buildTokenEnvVarName(serverName: string): string {
  const hash = crypto.createHash("sha256").update(serverName).digest("hex").slice(0, 12);
  return `OPENCLAW_MCP_AUTH_${hash.toUpperCase()}_TOKEN`;
}

function stripOpenClawOnlyOAuthConfig(server: BundleMcpServerConfig): BundleMcpServerConfig {
  const next = { ...server };
  delete next.auth;
  delete next.oauth;
  return next;
}

/** Resolves OAuth-backed MCP servers into bearer headers for external runtimes. */
export async function resolveMcpBearerBundleConfig(
  params: {
    config: BundleMcpConfig;
    env?: Record<string, string>;
    tokenProjection?: "env" | "literal";
    omitUnavailableOAuthServers?: boolean;
    onServerUnavailable?: (serverName: string, error: unknown) => void;
  } & McpAuthProfileOptions,
): Promise<{ config: BundleMcpConfig; env?: Record<string, string> }> {
  let nextServers: Record<string, BundleMcpServerConfig> | undefined;
  let nextEnv = params.env;
  const tokenProjection = params.tokenProjection ?? "env";

  for (const [serverName, server] of Object.entries(params.config.mcpServers)) {
    let token: string | undefined;
    try {
      token = await resolveMcpBearerToken({
        serverName,
        server,
        cfg: params.cfg,
        agentDir: params.agentDir,
      });
    } catch (error) {
      if (!params.omitUnavailableOAuthServers || !requiresMcpBearerProjection(server)) {
        throw error;
      }
      nextServers ??= { ...params.config.mcpServers };
      delete nextServers[serverName];
      params.onServerUnavailable?.(serverName, error);
      continue;
    }
    if (!token) {
      continue;
    }
    let authorization: string;
    if (tokenProjection === "literal") {
      authorization = `Bearer ${token}`;
    } else {
      const envVar = buildTokenEnvVarName(serverName);
      if (!nextEnv || nextEnv === params.env) {
        nextEnv = { ...params.env };
      }
      nextEnv[envVar] = token;
      authorization = `Bearer \${${envVar}}`;
    }
    const headers = withoutAuthorizationHeader(normalizeStringHeaders(server.headers));
    nextServers ??= { ...params.config.mcpServers };
    nextServers[serverName] = stripOpenClawOnlyOAuthConfig({
      ...server,
      headers: {
        ...headers,
        Authorization: authorization,
      },
    });
  }

  return {
    config: nextServers ? { mcpServers: nextServers } : params.config,
    env: nextEnv,
  };
}
