// Nextcloud Talk plugin module implements room info behavior.
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { ssrfPolicyFromPrivateNetworkOptIn } from "openclaw/plugin-sdk/ssrf-runtime";
import { fetchWithSsrFGuard, type RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkApiCredentials } from "./api-credentials.js";
import { releaseNextcloudTalkGuardedResponse } from "./guarded-response.js";

const ROOM_CACHE_TTL_MS = 5 * 60 * 1000;
const ROOM_CACHE_ERROR_TTL_MS = 30 * 1000;
const ROOM_CACHE_MAX_ENTRIES = 1000;
const NEXTCLOUD_TALK_ROOM_INFO_TIMEOUT_MS = 30_000;

const roomCache = new Map<
  string,
  { kind?: "direct" | "group"; fetchedAt: number; error?: string }
>();

function resolveRoomCacheKey(params: { accountId: string; roomToken: string }) {
  return `${params.accountId}:${params.roomToken}`;
}

function cacheRoomInfo(
  key: string,
  value: { kind?: "direct" | "group"; fetchedAt: number; error?: string },
): void {
  roomCache.set(key, value);
  pruneMapToMaxSize(roomCache, ROOM_CACHE_MAX_ENTRIES);
}

function coerceRoomType(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  return parseStrictPositiveInteger(value);
}

function resolveRoomKindFromType(type: number | undefined): "direct" | "group" | undefined {
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
}): Promise<"direct" | "group" | undefined> {
  const { account, roomToken, runtime } = params;
  const key = resolveRoomCacheKey({ accountId: account.accountId, roomToken });
  const cached = roomCache.get(key);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    if (cached.kind && age < ROOM_CACHE_TTL_MS) {
      return cached.kind;
    }
    if (cached.error && age < ROOM_CACHE_ERROR_TTL_MS) {
      return undefined;
    }
  }

  const apiCredentials = resolveNextcloudTalkApiCredentials({
    apiUser: account.config.apiUser,
    apiPassword: account.config.apiPassword,
    apiPasswordFile: account.config.apiPasswordFile,
  });
  if (!apiCredentials) {
    return undefined;
  }

  const baseUrl = account.baseUrl?.trim();
  if (!baseUrl) {
    return undefined;
  }

  const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v4/room/${roomToken}`;
  const auth = Buffer.from(
    `${apiCredentials.apiUser}:${apiCredentials.apiPassword}`,
    "utf-8",
  ).toString("base64");

  try {
    const { response, release } = await fetchWithSsrFGuard({
      url,
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
    try {
      if (!response.ok) {
        cacheRoomInfo(key, {
          fetchedAt: Date.now(),
          error: `status:${response.status}`,
        });
        runtime?.log?.(
          `nextcloud-talk: room lookup failed (${response.status}) token=${roomToken}`,
        );
        return undefined;
      }

      const payload = await readProviderJsonResponse<{
        ocs?: { data?: { type?: number | string } };
      }>(response, "Nextcloud Talk room info failed");
      const type = coerceRoomType(payload.ocs?.data?.type);
      const kind = resolveRoomKindFromType(type);
      cacheRoomInfo(key, { fetchedAt: Date.now(), kind });
      return kind;
    } finally {
      await releaseNextcloudTalkGuardedResponse({ response, release });
    }
  } catch (err) {
    cacheRoomInfo(key, {
      fetchedAt: Date.now(),
      error: formatErrorMessage(err),
    });
    runtime?.error?.(`nextcloud-talk: room lookup error: ${String(err)}`);
    return undefined;
  }
}
