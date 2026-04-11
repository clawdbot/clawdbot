import { fetchWithSsrFGuard, type MSTeamsConfig } from "../runtime-api.js";
import { GRAPH_ROOT } from "./attachments/shared.js";

const GRAPH_BETA = "https://graph.microsoft.com/beta";
import { createMSTeamsTokenProvider, loadMSTeamsSdkWithAuth } from "./sdk.js";
import { readAccessToken } from "./token-response.js";
import { resolveMSTeamsCredentials } from "./token.js";
import { buildUserAgent } from "./user-agent.js";

export type GraphUser = {
  id?: string;
  displayName?: string;
  userPrincipalName?: string;
  mail?: string;
};

export type GraphGroup = {
  id?: string;
  displayName?: string;
};

export type GraphChannel = {
  id?: string;
  displayName?: string;
};

export type GraphResponse<T> = { value?: T[] };

export function normalizeQuery(value?: string | null): string {
  return value?.trim() ?? "";
}

export function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

async function requestGraph(params: {
  token: string;
  path: string;
  method?: "GET" | "POST" | "DELETE";
  root?: string;
  headers?: Record<string, string>;
  body?: unknown;
  errorPrefix?: string;
}): Promise<Response> {
  const hasBody = params.body !== undefined;
  const res = await fetch(`${params.root ?? GRAPH_ROOT}${params.path}`, {
    method: params.method,
    headers: {
      "User-Agent": buildUserAgent(),
      Authorization: `Bearer ${params.token}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...params.headers,
    },
    body: hasBody ? JSON.stringify(params.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `${params.errorPrefix ?? "Graph"} ${params.path} failed (${res.status}): ${text || "unknown error"}`,
    );
  }
  return res;
}

async function readOptionalGraphJson<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export async function fetchGraphJson<T>(params: {
  token: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<T> {
  const res = await requestGraph({
    token: params.token,
    path: params.path,
    headers: params.headers,
  });
  return (await res.json()) as T;
}

/**
 * Fetch JSON from an absolute Graph API URL (e.g. @odata.nextLink pagination URLs).
 * Unlike {@link fetchGraphJson}, this does not prepend GRAPH_ROOT.
 *
 * Routed through `fetchWithSsrFGuard` so absolute-URL pagination follow-ups
 * honor the same SSRF policy as other Graph calls.
 */
export async function fetchGraphAbsoluteUrl<T>(params: {
  token: string;
  url: string;
  headers?: Record<string, string>;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: {
      headers: {
        "User-Agent": buildUserAgent(),
        Authorization: `Bearer ${params.token}`,
        ...params.headers,
      },
    },
    auditContext: "msteams.graph.absolute",
  });
  try {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Graph ${params.url} failed (${response.status}): ${text || "unknown error"}`,
      );
    }
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

export async function resolveGraphToken(cfg: unknown): Promise<string> {
  const creds = resolveMSTeamsCredentials(
    (cfg as { channels?: { msteams?: unknown } })?.channels?.msteams as MSTeamsConfig | undefined,
  );
  if (!creds) {
    throw new Error("MS Teams credentials missing");
  }
  const { app } = await loadMSTeamsSdkWithAuth(creds);
  const tokenProvider = createMSTeamsTokenProvider(app);
  const graphTokenValue = await tokenProvider.getAccessToken("https://graph.microsoft.com");
  const accessToken = readAccessToken(graphTokenValue);
  if (!accessToken) {
    throw new Error("MS Teams graph token unavailable");
  }
  return accessToken;
}

export async function listTeamsByName(token: string, query: string): Promise<GraphGroup[]> {
  const escaped = escapeOData(query);
  const filter = `resourceProvisioningOptions/Any(x:x eq 'Team') and startsWith(displayName,'${escaped}')`;
  const path = `/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName`;
  const res = await fetchGraphJson<GraphResponse<GraphGroup>>({ token, path });
  return res.value ?? [];
}

export async function postGraphJson<T>(params: {
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const res = await requestGraph({
    token: params.token,
    path: params.path,
    method: "POST",
    body: params.body,
    errorPrefix: "Graph POST",
  });
  return readOptionalGraphJson<T>(res);
}

export async function postGraphBetaJson<T>(params: {
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const res = await requestGraph({
    token: params.token,
    path: params.path,
    method: "POST",
    root: GRAPH_BETA,
    body: params.body,
    errorPrefix: "Graph beta POST",
  });
  return readOptionalGraphJson<T>(res);
}

export async function deleteGraphRequest(params: { token: string; path: string }): Promise<void> {
  await requestGraph({
    token: params.token,
    path: params.path,
    method: "DELETE",
    errorPrefix: "Graph DELETE",
  });
}

export async function listChannelsForTeam(token: string, teamId: string): Promise<GraphChannel[]> {
  const path = `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`;
  const res = await fetchGraphJson<GraphResponse<GraphChannel>>({ token, path });
  return res.value ?? [];
}
