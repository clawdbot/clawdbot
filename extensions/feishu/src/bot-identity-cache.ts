// Feishu plugin module implements provider-verified bot identity cache behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getFeishuRuntime } from "./runtime.js";

const FEISHU_BOT_IDENTITY_CACHE_NAMESPACE = "feishu.bot-identity-cache";
const FEISHU_BOT_IDENTITY_CACHE_MAX_ENTRIES = 128;

type FeishuBotIdentityCacheState = {
  appId: string;
  botOpenId: string;
  botName?: string;
  fetchedAt: string;
};

type CachedFeishuBotIdentity = {
  botOpenId: string;
  botName?: string;
  fetchedAt: string;
};

function openFeishuBotIdentityCache() {
  return getFeishuRuntime().state.openKeyedStore<FeishuBotIdentityCacheState>({
    namespace: FEISHU_BOT_IDENTITY_CACHE_NAMESPACE,
    maxEntries: FEISHU_BOT_IDENTITY_CACHE_MAX_ENTRIES,
  });
}

function parseCachedFeishuBotIdentity(value: unknown): FeishuBotIdentityCacheState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const state = value as Partial<FeishuBotIdentityCacheState>;
  const appId = normalizeOptionalString(state.appId);
  const botOpenId = normalizeOptionalString(state.botOpenId);
  const botName = normalizeOptionalString(state.botName);
  const fetchedAt = normalizeOptionalString(state.fetchedAt);
  if (!appId || !botOpenId || !fetchedAt || Number.isNaN(Date.parse(fetchedAt))) {
    return null;
  }
  return { appId, botOpenId, botName, fetchedAt };
}

export async function readCachedFeishuBotIdentity(params: {
  accountId: string;
  appId?: string;
}): Promise<CachedFeishuBotIdentity | null> {
  const appId = normalizeOptionalString(params.appId);
  if (!appId) {
    return null;
  }
  const cached = parseCachedFeishuBotIdentity(
    await openFeishuBotIdentityCache().lookup(normalizeAccountId(params.accountId)),
  );
  // The app id is the stable provider identity boundary. Secret rotation keeps
  // this cache valid; changing apps must never reuse another bot's identity.
  if (!cached || cached.appId !== appId) {
    return null;
  }
  return {
    botOpenId: cached.botOpenId,
    botName: cached.botName,
    fetchedAt: cached.fetchedAt,
  };
}

export async function writeCachedFeishuBotIdentity(params: {
  accountId: string;
  appId?: string;
  botOpenId?: string;
  botName?: string;
}): Promise<void> {
  const appId = normalizeOptionalString(params.appId);
  const botOpenId = normalizeOptionalString(params.botOpenId);
  if (!appId || !botOpenId) {
    return;
  }
  const botName = normalizeOptionalString(params.botName);
  await openFeishuBotIdentityCache().register(normalizeAccountId(params.accountId), {
    appId,
    botOpenId,
    botName,
    fetchedAt: new Date().toISOString(),
  });
}
