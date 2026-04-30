import { intro, note, outro, spinner } from "@clack/prompts";
import { stylePromptTitle } from "openclaw/plugin-sdk/cli-runtime";
import { logConfigUpdated, updateConfig } from "openclaw/plugin-sdk/config-mutation";
import {
  applyAuthProfileConfig,
  ensureAuthProfileStore,
  upsertAuthProfile,
} from "openclaw/plugin-sdk/provider-auth";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_DEVICE_VERIFICATION_URL = "https://github.com/login/device";

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
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

class GitHubDeviceFlowError extends Error {
  readonly kind: symbol;
  constructor(kind: symbol, message: string) {
    super(message);
    this.kind = kind;
    this.name = "GitHubDeviceFlowError";
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

async function requestDeviceCode(params: { scope: string }): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: params.scope,
  });

  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`GitHub device code failed: HTTP ${res.status}`);
  }

  const json = parseJsonResponse(await res.json()) as DeviceCodeResponse;
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("GitHub device code response missing fields");
  }
  return json;
}

async function pollForAccessToken(params: {
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
}): Promise<string> {
  const bodyBase = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: params.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  while (Date.now() < params.expiresAt) {
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: bodyBase,
    });

    if (!res.ok) {
      throw new Error(`GitHub device token failed: HTTP ${res.status}`);
    }

    const json = parseJsonResponse(await res.json()) as DeviceTokenResponse;
    if ("access_token" in json && typeof json.access_token === "string") {
      return json.access_token;
    }

    const err = "error" in json ? json.error : "unknown";
    if (err === "authorization_pending") {
      await new Promise((r) => setTimeout(r, params.intervalMs));
      continue;
    }
    if (err === "slow_down") {
      await new Promise((r) => setTimeout(r, params.intervalMs + 2000));
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

function normalizeGitHubDeviceVerificationUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("GitHub device flow returned an invalid verification URL");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.pathname !== "/login/device" ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("GitHub device flow returned an unexpected verification URL");
  }

  return GITHUB_DEVICE_VERIFICATION_URL;
}

function normalizeGitHubDeviceUserCode(raw: string): string {
  const userCode = raw.trim();
  if (!userCode || userCode.length > 64) {
    throw new Error("GitHub device flow returned an invalid user code");
  }
  return userCode;
}

export type GitHubCopilotDeviceFlowResult =
  | { status: "authorized"; accessToken: string }
  | { status: "access_denied" }
  | { status: "expired" };

export type GitHubCopilotDeviceFlowIO = {
  showCode(args: { verificationUrl: string; userCode: string; expiresInMs: number }): Promise<void>;
  openUrl?: (url: string) => Promise<void>;
};

export async function runGitHubCopilotDeviceFlow(
  io: GitHubCopilotDeviceFlowIO,
): Promise<GitHubCopilotDeviceFlowResult> {
  const device = await requestDeviceCode({ scope: "read:user" });
  const verificationUrl = normalizeGitHubDeviceVerificationUrl(device.verification_uri);
  const userCode = normalizeGitHubDeviceUserCode(device.user_code);
  const expiresInMs = device.expires_in * 1000;
  // Anchor expiry to when GitHub issued the code, not when the UI finishes prompting.
  const expiresAt = Date.now() + expiresInMs;

  await io.showCode({
    verificationUrl,
    userCode,
    expiresInMs,
  });

  try {
    await io.openUrl?.(verificationUrl);
  } catch {
    // The code and URL have already been shown. Browser launch is best-effort.
  }

  try {
    const accessToken = await pollForAccessToken({
      deviceCode: device.device_code,
      intervalMs: Math.max(1000, device.interval * 1000),
      expiresAt,
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

  const spin = spinner();
  spin.start("Requesting device code from GitHub...");
  const device = await requestDeviceCode({ scope: "read:user" });
  spin.stop("Device code ready");

  note(
    [`Visit: ${device.verification_uri}`, `Code: ${device.user_code}`].join("\n"),
    stylePromptTitle("Authorize"),
  );

  const expiresAt = Date.now() + device.expires_in * 1000;
  const intervalMs = Math.max(1000, device.interval * 1000);

  const polling = spinner();
  polling.start("Waiting for GitHub authorization...");
  const accessToken = await pollForAccessToken({
    deviceCode: device.device_code,
    intervalMs,
    expiresAt,
  });
  polling.stop("GitHub access token acquired");

  upsertAuthProfile({
    profileId,
    credential: {
      type: "token",
      provider: "github-copilot",
      token: accessToken,
    },
    agentDir: opts.agentDir,
  });

  await updateConfig((cfg) =>
    applyAuthProfileConfig(cfg, {
      provider: "github-copilot",
      profileId,
      mode: "token",
    }),
  );

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (github-copilot/token)`);

  outro("Done");
}
