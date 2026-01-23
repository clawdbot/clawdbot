import { intro, note, outro, select, spinner, text, isCancel } from "@clack/prompts";

import { ensureAuthProfileStore, upsertAuthProfile } from "../agents/auth-profiles.js";
import { updateConfig } from "../commands/models/shared.js";
import { applyAuthProfileConfig } from "../commands/onboard-auth.js";
import { logConfigUpdated } from "../config/logging.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import {
  normalizeGithubCopilotDomain,
  resolveGithubCopilotBaseUrl,
  resolveGithubCopilotUserAgent,
} from "./github-copilot-utils.js";

const CLIENT_ID = "Ov23li8tweQw6odWQebz";
const DEFAULT_DOMAIN = "github.com";
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;

function getUrls(domain: string) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  };
}

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

function parseJsonResponse<T>(value: unknown): T {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub");
  }
  return value as T;
}

async function requestDeviceCode(params: {
  scope: string;
  domain: string;
}): Promise<DeviceCodeResponse> {
  const body = JSON.stringify({
    client_id: CLIENT_ID,
    scope: params.scope,
  });

  const res = await fetch(getUrls(params.domain).deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": resolveGithubCopilotUserAgent(),
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`GitHub device code failed: HTTP ${res.status}`);
  }

  const json = parseJsonResponse<DeviceCodeResponse>(await res.json());
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("GitHub device code response missing fields");
  }
  return json;
}

async function pollForAccessToken(params: {
  domain: string;
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
}): Promise<string> {
  const bodyBase = {
    client_id: CLIENT_ID,
    device_code: params.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  };
  const urls = getUrls(params.domain);

  while (Date.now() < params.expiresAt) {
    const res = await fetch(urls.accessTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": resolveGithubCopilotUserAgent(),
      },
      body: JSON.stringify(bodyBase),
    });

    if (!res.ok) {
      throw new Error(`GitHub device token failed: HTTP ${res.status}`);
    }

    const json = parseJsonResponse<DeviceTokenResponse>(await res.json());
    if ("access_token" in json && typeof json.access_token === "string") {
      return json.access_token;
    }

    const err = "error" in json ? json.error : "unknown";
    if (err === "authorization_pending") {
      await new Promise((r) => setTimeout(r, params.intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS));
      continue;
    }
    if (err === "slow_down") {
      const serverInterval =
        "interval" in json && typeof json.interval === "number" ? json.interval : undefined;
      const nextInterval = serverInterval ? serverInterval * 1000 : params.intervalMs + 5000;
      await new Promise((r) => setTimeout(r, nextInterval + OAUTH_POLLING_SAFETY_MARGIN_MS));
      continue;
    }
    if (err === "expired_token") {
      throw new Error("GitHub device code expired; run login again");
    }
    if (err === "access_denied") {
      throw new Error("GitHub login cancelled");
    }
    throw new Error(`GitHub device flow error: ${err}`);
  }

  throw new Error("GitHub device code expired; run login again");
}

export async function githubCopilotLoginCommand(
  opts: { profileId?: string; yes?: boolean },
  runtime: RuntimeEnv,
) {
  if (!process.stdin.isTTY) {
    throw new Error("github-copilot login requires an interactive TTY.");
  }

  intro(stylePromptTitle("GitHub Copilot login"));

  const profileId = opts.profileId?.trim() || "github-copilot:github";
  const store = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: false,
  });

  if (store.profiles[profileId] && !opts.yes) {
    note(
      `Auth profile already exists: ${profileId}\nRe-running will overwrite it.`,
      stylePromptTitle("Existing credentials"),
    );
  }

  const deployment = await select({
    message: "Select GitHub deployment type",
    options: [
      { label: "GitHub.com", value: DEFAULT_DOMAIN, hint: "Public" },
      { label: "GitHub Enterprise", value: "enterprise", hint: "Data residency or self-hosted" },
    ],
  });
  if (isCancel(deployment)) {
    throw new Error("GitHub login cancelled");
  }

  let domain = DEFAULT_DOMAIN;
  let enterpriseDomain: string | null = null;
  if (deployment === "enterprise") {
    const enterpriseInput = await text({
      message: "Enter your GitHub Enterprise URL or domain",
      placeholder: "company.ghe.com or https://company.ghe.com",
      validate: (value) => {
        if (!value) return "URL or domain is required";
        return normalizeGithubCopilotDomain(value) ? undefined : "Enter a valid URL or domain";
      },
    });
    if (isCancel(enterpriseInput)) {
      throw new Error("GitHub login cancelled");
    }
    const normalized = normalizeGithubCopilotDomain(enterpriseInput);
    if (!normalized) {
      throw new Error("Invalid GitHub Enterprise URL/domain");
    }
    enterpriseDomain = normalized;
    domain = normalized;
  }

  const spin = spinner();
  spin.start("Requesting device code from GitHub...");
  const device = await requestDeviceCode({ scope: "read:user", domain });
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
    domain,
    deviceCode: device.device_code,
    intervalMs,
    expiresAt,
  });
  polling.stop("GitHub access token acquired");

  upsertAuthProfile({
    profileId,
    credential: {
      type: "oauth",
      provider: "github-copilot",
      refresh: accessToken,
      access: accessToken,
      // Copilot access tokens are treated as non-expiring (see resolveApiKeyForProfile).
      expires: 0,
      enterpriseUrl: enterpriseDomain ?? undefined,
    },
  });

  await updateConfig((cfg) =>
    applyAuthProfileConfig(cfg, {
      provider: "github-copilot",
      profileId,
      mode: "oauth",
    }),
  );

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (github-copilot/oauth)`);
  runtime.log(`Base URL: ${resolveGithubCopilotBaseUrl(enterpriseDomain ?? undefined)}`);

  outro("Done");
}
