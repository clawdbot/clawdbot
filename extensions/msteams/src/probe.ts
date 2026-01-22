import type { MSTeamsConfig } from "clawdbot/plugin-sdk";
import { formatUnknownError } from "./errors.js";
import { loadMSTeamsSdkWithAuth } from "./sdk.js";
import { resolveMSTeamsCredentials } from "./token.js";

export type ProbeMSTeamsResult = {
  ok: boolean;
  error?: string;
  appId?: string;
  graph?: {
    ok: boolean;
    error?: string;
    roles?: string[];
    scopes?: string[];
  };
};

function readAccessToken(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const token =
      (value as { accessToken?: unknown }).accessToken ??
      (value as { token?: unknown }).token;
    return typeof token === "string" ? token : null;
  }
  return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
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
  if (!Array.isArray(value)) return undefined;
  const out = value.map((entry) => String(entry).trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function readScopes(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const out = value.split(/\s+/).map((entry) => entry.trim()).filter(Boolean);
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
    const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
    const tokenProvider = new sdk.MsalTokenProvider(authConfig);
    await tokenProvider.getAccessToken("https://api.botframework.com/.default");
    let graph:
      | {
          ok: boolean;
          error?: string;
          roles?: string[];
          scopes?: string[];
        }
      | undefined;
    try {
      const graphToken = await tokenProvider.getAccessToken(
        "https://graph.microsoft.com",
      );
      const accessToken = readAccessToken(graphToken);
      const payload = accessToken ? decodeJwtPayload(accessToken) : null;
      graph = {
        ok: true,
        roles: readStringArray(payload?.roles),
        scopes: readScopes(payload?.scp),
      };
    } catch (err) {
      graph = { ok: false, error: formatUnknownError(err) };
    }
    return { ok: true, appId: creds.appId, ...(graph ? { graph } : {}) };
  } catch (err) {
    return {
      ok: false,
      appId: creds.appId,
      error: formatUnknownError(err),
    };
  }
}
