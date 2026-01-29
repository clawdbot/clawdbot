import type { LarkConfig, LarkCredentials } from "./types.js";

type TokenCache = {
  token: string;
  expiresAt: number;
};

const cache = new Map<string, TokenCache>();

export function resolveLarkCredentials(cfg?: LarkConfig): LarkCredentials | null {
  if (!cfg?.appId || !cfg?.appSecret) return null;
  return {
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    encryptKey: cfg.encryptKey,
    verificationToken: cfg.verificationToken,
    baseUrl: cfg.baseUrl ?? "https://open.feishu.cn",
  };
}

export async function getTenantAccessToken(creds: LarkCredentials): Promise<string> {
  const cacheKey = creds.appId;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const url = `${creds.baseUrl.replace(/\/$/, "")}/open-apis/auth/v3/tenant_access_token/internal`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: creds.appId,
      app_secret: creds.appSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to get tenant access token: ${res.statusText}`);
  }

  const data = await res.json() as { code: number; msg: string; tenant_access_token: string; expire: number };
  if (data.code !== 0) {
    throw new Error(`Feishu auth error: ${data.msg}`);
  }

  cache.set(cacheKey, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire * 1000),
  });

  return data.tenant_access_token;
}
