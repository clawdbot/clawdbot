import {
  normalizeStringEntries,
  type BaseProbeResult,
  type MSTeamsConfig,
} from "../runtime-api.js";
import { formatUnknownError } from "./errors.js";
import { createMSTeamsTokenProvider, loadMSTeamsSdkWithAuth } from "./sdk.js";
import { readAccessToken } from "./token-response.js";
import { resolveMSTeamsCredentials } from "./token.js";

export type ProbeMSTeamsResult = BaseProbeResult<string> & {
  appId?: string;
  graph?: {
    ok: boolean;
    error?: string;
    roles?: string[];
    scopes?: string[];
  };
  delegatedAuth?: {
    ok: boolean;
    error?: string;
    scopes?: string[];
    userPrincipalName?: string;
  };
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  const payload = parts[1] ?? "";
  const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = normalizeStringEntries(value);
  return out.length > 0 ? out : undefined;
}

function readScopes(value: unknown): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const out = value
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

export async function probeMSTeams(cfg?: MSTeamsConfig): Promise<ProbeMSTeamsResult> {
  const creds = resolveMSTeamsCredentials(cfg);
  if (!creds) {
    return {
      ok: false,
      error: "missing credentials (appId, appPassword, tenantId)",
    };
  }

  try {
    const { app } = await loadMSTeamsSdkWithAuth(creds);
    const tokenProvider = createMSTeamsTokenProvider(app);
    const botTokenValue = await tokenProvider.getAccessToken("https://api.botframework.com");
    if (!botTokenValue) {
      throw new Error("Failed to acquire bot token");
    }

    let graph:
      | {
          ok: boolean;
          error?: string;
          roles?: string[];
          scopes?: string[];
        }
      | undefined;
    try {
      const graphTokenValue = await tokenProvider.getAccessToken("https://graph.microsoft.com");
      const accessToken = readAccessToken(graphTokenValue);
      const payload = accessToken ? decodeJwtPayload(accessToken) : null;
      graph = {
        ok: true,
        roles: readStringArray(payload?.roles),
        scopes: readScopes(payload?.scp),
      };
    } catch (err) {
      graph = { ok: false, error: formatUnknownError(err) };
    }
    let delegatedAuth: ProbeMSTeamsResult["delegatedAuth"];
    if (cfg?.delegatedAuth?.enabled) {
      try {
        const { loadDelegatedTokens } = await import("./token.js");
        const tokens = loadDelegatedTokens();
        if (tokens) {
          const isExpired = tokens.expiresAt <= Date.now();
          delegatedAuth = {
            ok: !isExpired,
            scopes: tokens.scopes,
            userPrincipalName: tokens.userPrincipalName,
            ...(isExpired ? { error: "token expired (will auto-refresh on next use)" } : {}),
          };
        } else {
          delegatedAuth = { ok: false, error: "no delegated tokens found (run setup wizard)" };
        }
      } catch {
        delegatedAuth = { ok: false, error: "failed to load delegated tokens" };
      }
    }
    return {
      ok: true,
      appId: creds.appId,
      ...(graph ? { graph } : {}),
      ...(delegatedAuth ? { delegatedAuth } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      appId: creds.appId,
      error: formatUnknownError(err),
    };
  }
}
