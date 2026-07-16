/**
 * Feishu app registration via OAuth device-code flow.
 *
 * Migrated from feishu-plugin-cli's `feishu-auth.ts` and `install-prompts.ts`.
 * Replaces axios with native fetch, removes inquirer/ora/chalk in favor of
 * the openclaw WizardPrompter surface.
 */

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { FeishuDomain } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FEISHU_ACCOUNTS_URL = "https://accounts.feishu.cn";
const LARK_ACCOUNTS_URL = "https://accounts.larksuite.com";

const REGISTRATION_PATH = "/oauth/v1/app/registration";

const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppRegistrationResult {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  openId?: string;
}

interface InitResponse {
  nonce: string;
  supported_auth_methods: string[];
}

export interface BeginResult {
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  interval: number;
  expireIn: number;
}

interface RawBeginResponse {
  device_code: string;
  verification_uri: string;
  user_code: string;
  verification_uri_complete: string;
  interval: number;
  expire_in: number;
}

interface PollResponse {
  client_id?: string;
  client_secret?: string;
  user_info?: {
    open_id?: string;
    tenant_brand?: "feishu" | "lark";
  };
  error?: string;
  error_description?: string;
}

export type PollOutcome =
  | { status: "success"; result: AppRegistrationResult }
  | { status: "access_denied" }
  | { status: "expired" }
  | { status: "timeout" }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function accountsBaseUrl(domain: FeishuDomain): string {
  return domain === "lark" ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
}

async function postRegistration<T>(baseUrl: string, body: Record<string, string>): Promise<T> {
  return await fetchFeishuJson<T>({
    url: `${baseUrl}${REGISTRATION_PATH}`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    auditContext: "feishu.app-registration.post",
  });
}

async function fetchFeishuJson<T>(params: {
  url: string;
  init: RequestInit;
  auditContext: string;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: params.init,
    policy: { allowedHostnames: [new URL(params.url).hostname] },
    auditContext: params.auditContext,
  });
  try {
    // Registration poll returns 4xx for pending/error states with a JSON body.
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Step 1: Initialize registration and verify the environment supports
 * `client_secret` auth.
 *
 * @throws If the environment does not support `client_secret`.
 */
export async function initAppRegistration(domain: FeishuDomain = "feishu"): Promise<void> {
  const baseUrl = accountsBaseUrl(domain);
  const res = await postRegistration<InitResponse>(baseUrl, { action: "init" });

  if (!res.supported_auth_methods?.includes("client_secret")) {
    throw new Error("Current environment does not support client_secret auth method");
  }
}

/**
 * Step 2: Begin the device-code flow. Returns a device code and a QR URL
 * that the user should scan with Feishu/Lark mobile app.
 */
export async function beginAppRegistration(domain: FeishuDomain = "feishu"): Promise<BeginResult> {
  const baseUrl = accountsBaseUrl(domain);
  const res = await postRegistration<RawBeginResponse>(baseUrl, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });

  const qrUrl = new URL(res.verification_uri_complete);
  qrUrl.searchParams.set("from", "oc_onboard");
  qrUrl.searchParams.set("tp", "ob_cli_app");

  return {
    deviceCode: res.device_code,
    qrUrl: qrUrl.toString(),
    userCode: res.user_code,
    interval: res.interval || 5,
    expireIn: res.expire_in || 600,
  };
}

/**
 * Step 3: Poll for authorization result until success, denial, expiry, or
 * timeout. Automatically handles domain switching when `tenant_brand` is
 * detected as "lark".
 */
export async function pollAppRegistration(params: {
  deviceCode: string;
  interval: number;
  expireIn: number;
  initialDomain?: FeishuDomain;
  abortSignal?: AbortSignal;
  /** Registration type parameter: "ob_user" for user mode, "ob_app" for bot mode. */
  tp?: string;
}): Promise<PollOutcome> {
  const { deviceCode, expireIn, initialDomain = "feishu", abortSignal, tp } = params;
  let currentInterval = params.interval;
  let domain: FeishuDomain = initialDomain;
  let domainSwitched = false;

  const deadline = Date.now() + expireIn * 1000;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      return { status: "timeout" };
    }

    const baseUrl = accountsBaseUrl(domain);

    let pollRes: PollResponse;
    try {
      pollRes = await postRegistration<PollResponse>(baseUrl, {
        action: "poll",
        device_code: deviceCode,
        ...(tp ? { tp } : {}),
      });
    } catch {
      // Transient network error — keep polling.
      await sleep(currentInterval * 1000);
      continue;
    }

    // Domain auto-detection: switch to lark if tenant_brand says so.
    if (pollRes.user_info?.tenant_brand) {
      const isLark = pollRes.user_info.tenant_brand === "lark";
      if (!domainSwitched && isLark) {
        domain = "lark";
        domainSwitched = true;
        // Retry poll immediately with the correct domain.
        continue;
      }
    }

    // Success.
    if (pollRes.client_id && pollRes.client_secret) {
      return {
        status: "success",
        result: {
          appId: pollRes.client_id,
          appSecret: pollRes.client_secret,
          domain,
          openId: pollRes.user_info?.open_id,
        },
      };
    }

    // Error handling.
    if (pollRes.error) {
      if (pollRes.error === "authorization_pending") {
        // Continue waiting.
      } else if (pollRes.error === "slow_down") {
        currentInterval += 5;
      } else if (pollRes.error === "access_denied") {
        return { status: "access_denied" };
      } else if (pollRes.error === "expired_token") {
        return { status: "expired" };
      } else {
        return {
          status: "error",
          message: `${pollRes.error}: ${pollRes.error_description ?? "unknown"}`,
        };
      }
    }

    await sleep(currentInterval * 1000);
  }

  return { status: "timeout" };
}

/**
 * Print QR code directly to stdout.
 *
 * QR codes must be printed without any surrounding box/border decoration,
 * otherwise the pattern is corrupted and cannot be scanned.
 */
export async function printQrCode(url: string): Promise<void> {
  const mod = await import("qrcode-terminal");
  const qrcode = mod.default ?? mod;
  qrcode.generate(url, { small: true });
}

/**
 * Fetch the app owner's open_id using the application.v6.application.get API.
 *
 * Used during setup to auto-populate security policy allowlists.
 * Returns undefined on any failure (fail-open).
 */
export async function getAppOwnerOpenId(params: {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
}): Promise<string | undefined> {
  const baseUrl =
    params.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";

  try {
    // First, get a tenant_access_token.
    const tokenData = await fetchFeishuJson<{
      code?: number;
      tenant_access_token?: string;
    }>({
      url: `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: params.appId, app_secret: params.appSecret }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      auditContext: "feishu.app-registration.owner-token",
    });
    if (!tokenData.tenant_access_token) {
      return undefined;
    }

    // Query app info for the owner's open_id.
    const appData = await fetchFeishuJson<{
      code?: number;
      data?: {
        app?: {
          owner?: { owner_id?: string; owner_type?: number; type?: number };
          creator_id?: string;
        };
      };
    }>({
      url: `${baseUrl}/open-apis/application/v6/applications/${params.appId}?user_id_type=open_id`,
      init: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokenData.tenant_access_token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      auditContext: "feishu.app-registration.owner-app",
    });
    if (appData.code !== 0) {
      return undefined;
    }

    const app = appData.data?.app;
    const owner = app?.owner;
    const ownerType = owner?.owner_type ?? owner?.type;
    // owner_type=2 means enterprise member; use owner_id. Otherwise fallback to creator_id.
    return ownerType === 2 && owner?.owner_id
      ? owner.owner_id
      : (app?.creator_id ?? owner?.owner_id);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
