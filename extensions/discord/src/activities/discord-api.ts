import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

export const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
export const DISCORD_USER_URL = "https://discord.com/api/v10/users/@me";
const DISCORD_HOST = "discord.com";
const JSON_MAX_BYTES = 64 * 1024;
const INSTANCE_ID_MAX_LENGTH = 256;

export { fetchWithSsrFGuard };
export type FetchGuard = typeof fetchWithSsrFGuard;

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
  url: string;
  init: RequestInit;
  auditContext: string;
}): Promise<{ ok: boolean; status: number; body?: Record<string, unknown> }> {
  const { response, release } = await params.fetchGuard({
    url: params.url,
    fetchImpl: params.fetchImpl,
    init: params.init,
    policy: { allowedHostnames: [DISCORD_HOST] },
    auditContext: params.auditContext,
    timeoutMs: 15_000,
  });
  try {
    if (!response.ok) {
      return { ok: false, status: response.status };
    }
    return {
      ok: true,
      status: response.status,
      body: await readProviderJsonResponse<Record<string, unknown>>(
        response,
        "Discord Activity OAuth",
        {
          maxBytes: JSON_MAX_BYTES,
        },
      ),
    };
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
    result = await fetchDiscordJson({
      fetchGuard: params.fetchGuard,
      fetchImpl: params.proxyFetch,
      url: `https://discord.com/api/v10/applications/${encodeURIComponent(params.applicationId)}/activity-instances/${encodeURIComponent(params.instanceId)}`,
      init: { headers: { Authorization: `Bot ${params.botAuth}` } },
      auditContext: "discord.activities.instance",
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
