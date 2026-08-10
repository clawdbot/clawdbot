// Nextcloud Talk plugin module implements room info behavior.
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";
import { ssrfPolicyFromPrivateNetworkOptIn } from "openclaw/plugin-sdk/ssrf-runtime";
import { fetchWithSsrFGuard, type RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkApiCredentials } from "./api-credentials.js";
import { releaseNextcloudTalkGuardedResponse } from "./guarded-response.js";

const ROOM_CACHE_TTL_MS = 5 * 60 * 1000;
const ROOM_CACHE_ERROR_TTL_MS = 30 * 1000;
const ROOM_CACHE_MAX_ENTRIES = 1000;
const NEXTCLOUD_TALK_ROOM_INFO_TIMEOUT_MS = 30_000;

type NextcloudTalkRoomKind = "direct" | "group";
type NextcloudTalkRoomKindResult = {
  kind?: NextcloudTalkRoomKind;
  source: "cache" | "resolved" | "unconfigured" | "unknown" | "failed";
};

const roomCache = new Map<
  string,
  { kind?: NextcloudTalkRoomKind; fetchedAt: number; error?: string }
>();

function resolveRoomCacheKey(params: { accountId: string; roomToken: string }) {
  return `${params.accountId}:${params.roomToken}`;
}

function cacheRoomInfo(
  key: string,
  value: { kind?: NextcloudTalkRoomKind; fetchedAt: number; error?: string },
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

function resolveRoomKindFromType(type: number | undefined): NextcloudTalkRoomKind | undefined {
  if (!type) {
    return undefined;
  }
  if (type === 1 || type === 5 || type === 6) {
    return "direct";
  }
  return "group";
}

function isTransientRoomInfoStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export async function resolveNextcloudTalkRoomKindResult(params: {
  account: ResolvedNextcloudTalkAccount;
  roomToken: string;
  runtime?: RuntimeEnv;
  timeoutMs?: number;
}): Promise<NextcloudTalkRoomKindResult> {
  const { account, roomToken, runtime } = params;
  const key = resolveRoomCacheKey({ accountId: account.accountId, roomToken });
  const cached = roomCache.get(key);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    if (cached.kind && age < ROOM_CACHE_TTL_MS) {
      return { kind: cached.kind, source: "cache" };
    }
    if (cached.error && age < ROOM_CACHE_ERROR_TTL_MS) {
      return { source: "unknown" };
    }
    roomCache.delete(key);
  }

  const apiCredentials = resolveNextcloudTalkApiCredentials({
    apiUser: account.config.apiUser,
    apiPassword: account.config.apiPassword,
    apiPasswordFile: account.config.apiPasswordFile,
  });
  if (!apiCredentials) {
    return { source: "unconfigured" };
  }

  const baseUrl = account.baseUrl?.trim();
  if (!baseUrl) {
    return { source: "unconfigured" };
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
        runtime?.log?.(
          `nextcloud-talk: room lookup failed (${response.status}) token=${roomToken}`,
        );
        if (isTransientRoomInfoStatus(response.status)) {
          return { source: "failed" };
        }
        cacheRoomInfo(key, {
          fetchedAt: Date.now(),
          error: `status:${response.status}`,
        });
        return { source: "unknown" };
      }

      let payload: { ocs?: { data?: { type?: number | string } } };
      try {
        payload = await readProviderJsonResponse<{
          ocs?: { data?: { type?: number | string } };
        }>(response, "Nextcloud Talk room info failed");
      } catch (err) {
        runtime?.error?.(`nextcloud-talk: room lookup error: ${String(err)}`);
        cacheRoomInfo(key, {
          fetchedAt: Date.now(),
          error: "malformed",
        });
        return { source: "unknown" };
      }
      const type = coerceRoomType(payload.ocs?.data?.type);
      const kind = resolveRoomKindFromType(type);
      if (!kind) {
        cacheRoomInfo(key, {
          fetchedAt: Date.now(),
          error: "unrecognized-room-kind",
        });
        return { source: "unknown" };
      }
      cacheRoomInfo(key, { fetchedAt: Date.now(), kind });
      return { kind, source: "resolved" };
    } finally {
      await releaseNextcloudTalkGuardedResponse({ response, release });
    }
  } catch (err) {
    if (err instanceof SsrFBlockedError) {
      runtime?.error?.(`nextcloud-talk: room lookup policy blocked: ${String(err)}`);
      cacheRoomInfo(key, {
        fetchedAt: Date.now(),
        error: "ssrf-blocked",
      });
      return { source: "unknown" };
    }
    runtime?.error?.(`nextcloud-talk: room lookup error: ${String(err)}`);
    return { source: "failed" };
  }
}
