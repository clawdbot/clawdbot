import { Routes } from "discord-api-types/v10";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { DISCORD_DEFAULT_REST_API_BASE_URL } from "../provider-endpoint.constants.js";
import { getDiscordProviderEndpointRuntime } from "../provider-endpoint.js";

const DISCORD_LIVE_OAUTH_API_BASE_URL = "https://discord.com/api";
const DISCORD_TOKEN_URL = `${DISCORD_LIVE_OAUTH_API_BASE_URL}${Routes.oauth2TokenExchange()}`;
const DISCORD_USER_URL = `${DISCORD_DEFAULT_REST_API_BASE_URL}${Routes.user()}`;
const DISCORD_HOST = "discord.com";
const DISCORD_ACTIVITY_API_TIMEOUT_MS = 15_000;
const JSON_MAX_BYTES = 64 * 1024;
const INSTANCE_ID_MAX_LENGTH = 256;

type DiscordActivityJsonRoute = Readonly<{
  providerPath: string;
  liveUrl: string;
  auditContext: string;
  responseLabel: string;
}>;

export const DISCORD_ACTIVITY_TOKEN_ROUTE: DiscordActivityJsonRoute = {
  providerPath: Routes.oauth2TokenExchange(),
  liveUrl: DISCORD_TOKEN_URL,
  auditContext: "discord.activities.oauth.token",
  responseLabel: "Discord Activity OAuth",
};

export const DISCORD_ACTIVITY_USER_ROUTE: DiscordActivityJsonRoute = {
  providerPath: Routes.user(),
  liveUrl: DISCORD_USER_URL,
  auditContext: "discord.activities.oauth.user",
  responseLabel: "Discord Activity OAuth",
};

export { fetchWithSsrFGuard };
export type FetchGuard = typeof fetchWithSsrFGuard;

async function readDiscordJsonResult(
  response: Response,
  label: string,
): Promise<{ ok: boolean; status: number; body?: Record<string, unknown> }> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, status: response.status };
  }
  return {
    ok: true,
    status: response.status,
    body: await readProviderJsonResponse<Record<string, unknown>>(response, label, {
      maxBytes: JSON_MAX_BYTES,
    }),
  };
}

export function normalizeInstanceId(value: string | null): string | undefined {
  const instanceId = value?.trim();
  let hasControlCharacter = false;
  for (let index = 0; index < (instanceId?.length ?? 0); index += 1) {
    const codePoint = instanceId?.charCodeAt(index) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      hasControlCharacter = true;
      break;
    }
  }
  if (!instanceId || instanceId.length > INSTANCE_ID_MAX_LENGTH || hasControlCharacter) {
    return undefined;
  }
  return instanceId;
}

export async function fetchDiscordJson(params: {
  fetchGuard: FetchGuard;
  fetchImpl?: typeof fetch;
  route: DiscordActivityJsonRoute;
  init: RequestInit;
}): Promise<{ ok: boolean; status: number; body?: Record<string, unknown> }> {
  const providerEndpoint = getDiscordProviderEndpointRuntime();
  if (providerEndpoint) {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), DISCORD_ACTIVITY_API_TIMEOUT_MS);
    timeout.unref?.();
    const signal = params.init.signal
      ? AbortSignal.any([params.init.signal, timeoutController.signal])
      : timeoutController.signal;
    try {
      const response = await providerEndpoint.fetch(
        `${providerEndpoint.descriptor.restApiBaseUrl}${params.route.providerPath}`,
        { ...params.init, signal },
      );
      return await readDiscordJsonResult(response, params.route.responseLabel);
    } finally {
      clearTimeout(timeout);
    }
  }

  const { response, release } = await params.fetchGuard({
    url: params.route.liveUrl,
    fetchImpl: params.fetchImpl,
    init: params.init,
    policy: { allowedHostnames: [DISCORD_HOST] },
    auditContext: params.route.auditContext,
    timeoutMs: DISCORD_ACTIVITY_API_TIMEOUT_MS,
  });
  try {
    return await readDiscordJsonResult(response, params.route.responseLabel);
  } finally {
    await release();
  }
}

export async function resolveActivityInstanceChannel(params: {
  fetchGuard: FetchGuard;
  applicationId: string;
  instanceId: string;
  discordUserId: string;
  botAuth: string;
  proxyFetch?: typeof fetch;
}): Promise<string | undefined> {
  let result: Awaited<ReturnType<typeof fetchDiscordJson>>;
  try {
    const providerPath = Routes.applicationActivityInstance(
      encodeURIComponent(params.applicationId),
      encodeURIComponent(params.instanceId),
    );
    result = await fetchDiscordJson({
      fetchGuard: params.fetchGuard,
      fetchImpl: params.proxyFetch,
      route: {
        providerPath,
        liveUrl: `${DISCORD_DEFAULT_REST_API_BASE_URL}${providerPath}`,
        auditContext: "discord.activities.instance",
        responseLabel: "Discord Activity instance",
      },
      init: { headers: { Authorization: `Bot ${params.botAuth}` } },
    });
  } catch {
    return undefined;
  }
  if (
    !result.ok ||
    !Array.isArray(result.body?.users) ||
    !result.body.users.includes(params.discordUserId) ||
    !result.body.location ||
    typeof result.body.location !== "object"
  ) {
    return undefined;
  }
  const channelId = (result.body.location as Record<string, unknown>).channel_id;
  return typeof channelId === "string" && /^\d+$/.test(channelId) ? channelId : undefined;
}
