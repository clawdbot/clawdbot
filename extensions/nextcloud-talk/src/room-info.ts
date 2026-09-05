import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  SsrFBlockedError,
  ssrfPolicyFromPrivateNetworkOptIn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { fetchWithSsrFGuard, type RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkApiCredentials } from "./api-credentials.js";
import { releaseNextcloudTalkGuardedResponse } from "./guarded-response.js";

const ROOM_CACHE_TTL_MS = 5 * 60 * 1000;
const ROOM_CACHE_ERROR_TTL_MS = 30 * 1000;
const ROOM_CACHE_MAX_ENTRIES = 1000;
const NEXTCLOUD_TALK_ROOM_INFO_TIMEOUT_MS = 30_000;

type NextcloudTalkRoomKind = "direct" | "group";
const roomCache = new Map<string, { kind: NextcloudTalkRoomKind | undefined; expiresAt: number }>();

function cacheRoomInfo(
  key: string,
  kind: NextcloudTalkRoomKind | undefined,
  ttlMs: number,
): NextcloudTalkRoomKind | undefined {
  roomCache.set(key, { kind, expiresAt: Date.now() + ttlMs });
  pruneMapToMaxSize(roomCache, ROOM_CACHE_MAX_ENTRIES);
  return kind;
}

function resolveRoomKindFromType(type: number | undefined): NextcloudTalkRoomKind | undefined {
  if (!type) {
    return undefined;
  }
  if (type === 1 || type === 5 || type === 6) {
    return "direct";
  }
  return "group";
}

export async function resolveNextcloudTalkRoomKind(params: {
  account: ResolvedNextcloudTalkAccount;
  roomToken: string;
  runtime?: RuntimeEnv;
  timeoutMs?: number;
}): Promise<NextcloudTalkRoomKind | undefined> {
  const { account, roomToken, runtime } = params;
  const key = `${account.accountId}:${roomToken}`;
  const cached = roomCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.kind;
  }
  roomCache.delete(key);

  const apiCredentials = resolveNextcloudTalkApiCredentials({
    apiUser: account.config.apiUser,
    apiPassword: account.config.apiPassword,
    apiPasswordFile: account.config.apiPasswordFile,
  });
  const baseUrl = account.baseUrl?.trim();
  if (!apiCredentials || !baseUrl) {
    return undefined;
  }
  const fallback = (error: unknown) => {
    runtime?.error?.(`nextcloud-talk: room lookup error: ${String(error)}`);
    return cacheRoomInfo(key, undefined, ROOM_CACHE_ERROR_TTL_MS);
  };
  const parsedBaseUrl = URL.parse(baseUrl);
  if (!parsedBaseUrl || !["http:", "https:"].includes(parsedBaseUrl.protocol)) {
    return fallback(new Error("Nextcloud Talk room lookup requires an HTTP(S) base URL"));
  }

  const auth = Buffer.from(
    `${apiCredentials.apiUser}:${apiCredentials.apiPassword}`,
    "utf-8",
  ).toString("base64");
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
  try {
    guarded = await fetchWithSsrFGuard({
      url: `${baseUrl}/ocs/v2.php/apps/spreed/api/v4/room/${roomToken}`,
      init: {
        method: "GET",
        headers: {
          Authorization: `Basic ${auth}`,
          "OCS-APIRequest": "true",
          Accept: "application/json",
        },
      },
      auditContext: "nextcloud-talk.room-info",
      policy: ssrfPolicyFromPrivateNetworkOptIn(account.config),
      timeoutMs: params.timeoutMs ?? NEXTCLOUD_TALK_ROOM_INFO_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof SsrFBlockedError) {
      return fallback(error);
    }
    // The durable ingress drain owns retries. Do not cache transport failures or
    // turn them into the webhook's non-authoritative group placeholder.
    throw error;
  }

  const { response, release } = guarded;
  try {
    if (!response.ok) {
      const status = response.status;
      if (status === 408 || status === 429 || (status >= 500 && status <= 599)) {
        throw new Error(`Nextcloud Talk room lookup failed (${status})`);
      }
      runtime?.log?.(`nextcloud-talk: room lookup failed (${status}) token=${roomToken}`);
      return cacheRoomInfo(key, undefined, ROOM_CACHE_ERROR_TTL_MS);
    }
    try {
      const payload = await readProviderJsonResponse<{
        ocs?: { data?: { type?: number | string } };
      }>(response, "Nextcloud Talk room info failed");
      const kind = resolveRoomKindFromType(parseStrictPositiveInteger(payload.ocs?.data?.type));
      return kind ? cacheRoomInfo(key, kind, ROOM_CACHE_TTL_MS) : undefined;
    } catch (error) {
      return fallback(error);
    }
  } finally {
    await releaseNextcloudTalkGuardedResponse({ response, release });
  }
}
