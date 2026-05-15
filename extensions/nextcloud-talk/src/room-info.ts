import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { ssrfPolicyFromPrivateNetworkOptIn } from "openclaw/plugin-sdk/ssrf-runtime";
import { fetchWithSsrFGuard, type RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkApiCredentials } from "./api-credentials.js";

const ROOM_CACHE_TTL_MS = 5 * 60 * 1000;
const ROOM_CACHE_ERROR_TTL_MS = 30 * 1000;

const roomCache = new Map<
  string,
  { kind?: "direct" | "group"; fetchedAt: number; error?: string }
>();

export const __testing = {
  resetRoomCache() {
    roomCache.clear();
  },
};

function resolveRoomCacheKey(params: { accountId: string; roomToken: string }) {
  return `${params.accountId}:${params.roomToken}`;
}

function coerceRoomType(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
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
    });
    try {
      if (!response.ok) {
        roomCache.set(key, {
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
      roomCache.set(key, { fetchedAt: Date.now(), kind });
      return kind;
    } finally {
      await release();
    }
  } catch (err) {
    roomCache.set(key, {
      fetchedAt: Date.now(),
      error: formatErrorMessage(err),
    });
    runtime?.error?.(`nextcloud-talk: room lookup error: ${String(err)}`);
    return undefined;
  }
}
