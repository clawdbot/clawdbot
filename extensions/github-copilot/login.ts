// Github Copilot plugin module implements login behavior.
import { intro, note, outro, spinner } from "@clack/prompts";
import { stylePromptTitle } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logConfigUpdated, updateConfig } from "openclaw/plugin-sdk/config-mutation";
import {
  resolveExpiresAtMsFromDurationMs,
  nonNegativeSecondsToSafeMilliseconds,
  positiveSecondsToSafeMilliseconds,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  applyAuthProfileConfig,
  ensureAuthProfileStore,
  normalizeGithubCopilotDomain,
  upsertAuthProfileWithLock,
} from "openclaw/plugin-sdk/provider-auth";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { PUBLIC_GITHUB_COPILOT_DOMAIN, resolveGithubCopilotDomain } from "./domain.js";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_DEVICE_FLOW_REQUEST_TIMEOUT_MS = 30_000;
// Data-residency GitHub Enterprise support: the device flow, token exchange, and
// completions endpoints all live under the tenant host (e.g. "acme.ghe.com")
// instead of github.com. The host is threaded in from the selected auth flow so
// the SSRF allowlist and every request target stay consistent for one login.
const deviceCodeUrl = (domain: string) => `https://${domain}/login/device/code`;
const accessTokenUrl = (domain: string) => `https://${domain}/login/oauth/access_token`;
const deviceVerificationUrl = (domain: string) => `https://${domain}/login/device`;
const githubAuthSsrfPolicy = (domain: string): SsrFPolicy => ({
  hostnameAllowlist: [domain],
});

type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInMs: number;
  expiresAt: number;
  intervalMs: number;
};

type DeviceTokenResponse =
  | {
      access_token: string;
      token_type: string;
      scope?: string;
    }
  | {
      error: string;
      error_description?: string;
      error_uri?: string;
    };

const GITHUB_DEVICE_ACCESS_DENIED = Symbol("github-device-access-denied");
const GITHUB_DEVICE_EXPIRED = Symbol("github-device-expired");

type UpsertAuthProfileParams = Parameters<typeof upsertAuthProfileWithLock>[0];

class GitHubDeviceFlowError extends Error {
  readonly kind: symbol;
  constructor(kind: symbol, message: string) {
    super(message);
    this.kind = kind;
    this.name = "GitHubDeviceFlowError";
  }
}

let githubDeviceFlowFetchGuard = fetchWithSsrFGuard;

export function setGitHubCopilotDeviceFlowFetchGuardForTesting(
  impl: typeof fetchWithSsrFGuard | null,
): void {
  githubDeviceFlowFetchGuard = impl ?? fetchWithSsrFGuard;
}

async function upsertAuthProfileWithLockOrThrow(params: UpsertAuthProfileParams): Promise<void> {
  const updated = await upsertAuthProfileWithLock(params);
  if (!updated) {
    throw new Error(
      "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
    );
  }
}

function isGitHubDeviceAccessDeniedError(err: unknown): boolean {
  return err instanceof GitHubDeviceFlowError && err.kind === GITHUB_DEVICE_ACCESS_DENIED;
}

function isGitHubDeviceExpiredError(err: unknown): boolean {
  return err instanceof GitHubDeviceFlowError && err.kind === GITHUB_DEVICE_EXPIRED;
}

function parseJsonResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub");
  }
  return value as Record<string, unknown>;
}

function parseDeviceCodeResponse(
  value: Record<string, unknown>,
  issuedAt: number,
): DeviceCodeResponse {
  const expiresInMs = positiveSecondsToSafeMilliseconds(value.expires_in);
  const intervalMs = nonNegativeSecondsToSafeMilliseconds(value.interval);
  const expiresAt =
    expiresInMs === undefined
      ? undefined
      : resolveExpiresAtMsFromDurationMs(expiresInMs, { nowMs: issuedAt });

  if (
    typeof value.device_code !== "string" ||
    !value.device_code ||
    typeof value.user_code !== "string" ||
    !value.user_code ||
    typeof value.verification_uri !== "string" ||
    !value.verification_uri ||
    expiresInMs === undefined ||
    expiresAt === undefined ||
    intervalMs === undefined
  ) {
    throw new Error("GitHub device code response missing fields");
  }

  return {
    deviceCode: value.device_code,
    userCode: value.user_code,
    verificationUri: value.verification_uri,
    expiresInMs,
    expiresAt,
    intervalMs,
  };
}

async function postGitHubDeviceFlowForm(params: {
  url: string;
  body: URLSearchParams;
  failureLabel: string;
  domain: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const { response, release } = await githubDeviceFlowFetchGuard({
    url: params.url,
    init: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.body,
    },
    ...(params.signal ? { signal: params.signal } : {}),
    requireHttps: true,
    policy: githubAuthSsrfPolicy(params.domain),
    auditContext: "github-copilot-device-flow",
    timeoutMs: GITHUB_DEVICE_FLOW_REQUEST_TIMEOUT_MS,
  });
  try {
    if (!response.ok) {
      throw new Error(`${params.failureLabel}: HTTP ${response.status}`);
    }
    return parseJsonResponse(
      await readProviderJsonResponse(response, "github-copilot.device-flow"),
    );
  } finally {
    await release();
  }
}

async function requestDeviceCode(params: {
  scope: string;
  domain: string;
  signal?: AbortSignal;
}): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: params.scope,
  });

  const json = await postGitHubDeviceFlowForm({
    url: deviceCodeUrl(params.domain),
    body,
    failureLabel: "GitHub device code failed",
    domain: params.domain,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  // Anchor expiry to when GitHub issued the code, before UI prompts or browser launch.
  return parseDeviceCodeResponse(json, Date.now());
}

async function pollForAccessToken(params: {
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
  domain: string;
  signal?: AbortSignal;
}): Promise<string> {
  const bodyBase = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: params.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  while (Date.now() < params.expiresAt) {
    const json = (await postGitHubDeviceFlowForm({
      url: accessTokenUrl(params.domain),
      body: bodyBase,
      failureLabel: "GitHub device token failed",
      domain: params.domain,
      ...(params.signal ? { signal: params.signal } : {}),
    })) as DeviceTokenResponse;
    if ("access_token" in json && typeof json.access_token === "string") {
      return json.access_token;
    }

    const err = "error" in json ? json.error : "unknown";
    if (err === "authorization_pending") {
      await sleepGitHubDevicePollDelay(params.intervalMs, params.expiresAt, params.signal);
      continue;
    }
    if (err === "slow_down") {
      await sleepGitHubDevicePollDelay(params.intervalMs + 2000, params.expiresAt, params.signal);
      continue;
    }
    if (err === "expired_token") {
      throw new GitHubDeviceFlowError(
        GITHUB_DEVICE_EXPIRED,
        "GitHub device code expired; run login again",
      );
    }
    if (err === "access_denied") {
      throw new GitHubDeviceFlowError(GITHUB_DEVICE_ACCESS_DENIED, "GitHub login cancelled");
    }
    throw new Error(`GitHub device flow error: ${err}`);
  }

  throw new GitHubDeviceFlowError(
    GITHUB_DEVICE_EXPIRED,
    "GitHub device code expired; run login again",
  );
}

async function sleepGitHubDevicePollDelay(
  delayMs: number,
  expiresAt: number,
  signal?: AbortSignal,
): Promise<void> {
  const requestedDelayMs = Math.max(1, Math.floor(delayMs));
  const targetAt = Math.min(Date.now() + requestedDelayMs, expiresAt);
  while (Date.now() < targetAt) {
    const remainingMs = Math.max(1, targetAt - Date.now());
    const safeDelayMs = resolveTimerTimeoutMs(remainingMs, 1);
    const waitMs = Math.min(safeDelayMs, remainingMs);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timeout);
        reject(
          signal?.reason instanceof Error ? signal.reason : new Error("GitHub login cancelled"),
        );
      };
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, waitMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
  }
}

function normalizeGitHubDeviceVerificationUrl(raw: string, domain: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("GitHub device flow returned an invalid verification URL");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== domain ||
    parsed.pathname !== "/login/device" ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("GitHub device flow returned an unexpected verification URL");
  }

  return deviceVerificationUrl(domain);
}

function normalizeGitHubDeviceUserCode(raw: string): string {
  const userCode = raw.trim();
  if (!userCode || userCode.length > 64) {
    throw new Error("GitHub device flow returned an invalid user code");
  }
  return userCode;
}

type GitHubCopilotDeviceFlowResult =
  | { status: "authorized"; accessToken: string }
  | { status: "access_denied" }
  | { status: "expired" };

type GitHubCopilotDeviceFlowIO = {
  showCode(args: { verificationUrl: string; userCode: string; expiresInMs: number }): Promise<void>;
  openUrl?: (url: string) => Promise<void>;
  signal?: AbortSignal;
};

export async function runGitHubCopilotDeviceFlow(
  io: GitHubCopilotDeviceFlowIO,
  domain: string = PUBLIC_GITHUB_COPILOT_DOMAIN,
): Promise<GitHubCopilotDeviceFlowResult> {
  const host = normalizeGithubCopilotDomain(domain);
  const device = await requestDeviceCode({
    scope: "read:user",
    domain: host,
    ...(io.signal ? { signal: io.signal } : {}),
  });
  const verificationUrl = normalizeGitHubDeviceVerificationUrl(device.verificationUri, host);
  const userCode = normalizeGitHubDeviceUserCode(device.userCode);
  await io.showCode({
    verificationUrl,
    userCode,
    expiresInMs: device.expiresInMs,
  });

  try {
    await io.openUrl?.(verificationUrl);
  } catch {
    // The code and URL have already been shown. Browser launch is best-effort.
  }

  try {
    const accessToken = await pollForAccessToken({
      deviceCode: device.deviceCode,
      intervalMs: Math.max(1000, device.intervalMs),
      expiresAt: device.expiresAt,
      domain: host,
      ...(io.signal ? { signal: io.signal } : {}),
    });
    return { status: "authorized", accessToken };
  } catch (err) {
    if (isGitHubDeviceAccessDeniedError(err)) {
      return { status: "access_denied" };
    }
    if (isGitHubDeviceExpiredError(err)) {
      return { status: "expired" };
    }
    throw err;
  }
}

// The shortcut login mints its token against the resolved domain, so the same
// domain must land in persisted config: a tenant token with no stored
// githubDomain would silently route to github.com (and 401) once
// COPILOT_GITHUB_DOMAIN is unset. Mirrors the enterprise auth method's
// persist-on-tenant / clear-on-public behavior.
export function withGithubCopilotDomainConfig(cfg: OpenClawConfig, domain: string): OpenClawConfig {
  // Normalize the optional layers to concrete objects before spreading:
  // spreading a possibly-undefined object widens every optional property to
  // `T | undefined`, which exactOptionalPropertyTypes rejects.
  const models: NonNullable<OpenClawConfig["models"]> = cfg.models ?? {};
  const providers: NonNullable<typeof models.providers> = models.providers ?? {};
  const provider = providers["github-copilot"];
  const params = provider?.params;
  const isDefault = domain === PUBLIC_GITHUB_COPILOT_DOMAIN;
  if (isDefault && !(params && "githubDomain" in params)) {
    return cfg;
  }
  const nextParams: Record<string, unknown> = { ...params };
  if (isDefault) {
    delete nextParams.githubDomain;
  } else {
    nextParams.githubDomain = domain;
  }
  const nextProviders = { ...providers };
  if (provider) {
    nextProviders["github-copilot"] = { ...provider, params: nextParams };
  } else {
    // Source config accepts partial provider inputs; catalog materialization
    // supplies baseUrl/models before runtime consumption.
    Object.assign(nextProviders, { "github-copilot": { params: nextParams } });
  }
  return {
    ...cfg,
    models: {
      ...models,
      providers: nextProviders,
    },
  };
}

export async function githubCopilotLoginCommand(
  opts: { profileId?: string; yes?: boolean; agentDir?: string },
  runtime: RuntimeEnv,
) {
  if (!process.stdin.isTTY) {
    throw new Error("github-copilot login requires an interactive TTY.");
  }

  intro(stylePromptTitle("GitHub Copilot login"));

  const profileId = opts.profileId?.trim() || "github-copilot:github";
  const store = ensureAuthProfileStore(opts.agentDir, {
    allowKeychainPrompt: false,
  });

  if (store.profiles[profileId] && !opts.yes) {
    note(
      `Auth profile already exists: ${profileId}\nRe-running will overwrite it.`,
      stylePromptTitle("Existing credentials"),
    );
  }

  // Mint against the same host the runtime will route to. resolveGithubCopilotDomain
  // is env-authoritative (COPILOT_GITHUB_DOMAIN wins), and runtime token exchange
  // uses the same resolver, so honoring it here keeps the minted token and the
  // runtime endpoint on the same tenant instead of minting a public token that
  // then 401s against api.<tenant>.
  const domain = resolveGithubCopilotDomain();
  if (domain !== PUBLIC_GITHUB_COPILOT_DOMAIN) {
    note(
      `Using the GitHub Enterprise domain from COPILOT_GITHUB_DOMAIN (${domain}). Unset it to log in against github.com.`,
      stylePromptTitle("GitHub Copilot"),
    );
  }

  const spin = spinner();
  spin.start(`Requesting device code from ${domain}...`);
  const device = await requestDeviceCode({
    scope: "read:user",
    domain,
  });
  spin.stop("Device code ready");

  note(
    [`Visit: ${device.verificationUri}`, `Code: ${device.userCode}`].join("\n"),
    stylePromptTitle("Authorize"),
  );

  const intervalMs = Math.max(1000, device.intervalMs);

  const polling = spinner();
  polling.start("Waiting for GitHub authorization...");
  const accessToken = await pollForAccessToken({
    deviceCode: device.deviceCode,
    intervalMs,
    expiresAt: device.expiresAt,
    domain,
  });
  polling.stop("GitHub access token acquired");

  await upsertAuthProfileWithLockOrThrow({
    profileId,
    credential: {
      type: "token",
      provider: "github-copilot",
      token: accessToken,
    },
    agentDir: opts.agentDir,
  });

  await updateConfig((cfg) =>
    withGithubCopilotDomainConfig(
      applyAuthProfileConfig(cfg, {
        provider: "github-copilot",
        profileId,
        mode: "token",
      }),
      domain,
    ),
  );

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (github-copilot/token)`);

  outro("Done");
}
