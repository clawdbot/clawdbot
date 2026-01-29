import { intro, note, outro, spinner } from "@clack/prompts";

import { ensureAuthProfileStore, upsertAuthProfile } from "../agents/auth-profiles.js";
import { updateConfig } from "../commands/models/shared.js";
import {
  applyAuthProfileConfig,
  applyNanoGptConfig,
  setNanoGptApiKey,
} from "../commands/onboard-auth.js";
import { logConfigUpdated } from "../config/logging.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";

const CLI_LOGIN_START_URL = "https://nano-gpt.com/api/cli-login/start";
const CLI_LOGIN_POLL_URL = "https://nano-gpt.com/api/cli-login/poll";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const CLIENT_NAME = "moltbot";

type StartResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval?: number;
};

type PollResponse =
  | { status: "pending" }
  | { status: "approved"; key: string }
  | { status: "expired" }
  | { status: "consumed" };

async function requestDeviceCode(): Promise<StartResponse> {
  const res = await fetch(CLI_LOGIN_START_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ client_name: CLIENT_NAME }),
  });

  if (!res.ok) {
    throw new Error(`NanoGPT device code request failed: HTTP ${res.status}`);
  }

  const json = (await res.json()) as StartResponse;
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("NanoGPT device code response missing required fields");
  }
  return json;
}

async function pollForApiKey(params: {
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
}): Promise<string> {
  while (Date.now() < params.expiresAt) {
    const res = await fetch(CLI_LOGIN_POLL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ device_code: params.deviceCode }),
    });

    // 202: continue polling
    if (res.status === 202) {
      await new Promise((r) => setTimeout(r, params.intervalMs));
      continue;
    }

    // 200: approved
    if (res.status === 200) {
      const json = (await res.json()) as PollResponse;
      if (json.status === "approved" && "key" in json) {
        return json.key;
      }
      throw new Error("NanoGPT returned 200 but no API key");
    }

    // 410: expired
    if (res.status === 410) {
      throw new Error("NanoGPT device code expired; run login again");
    }

    // 409: already consumed
    if (res.status === 409) {
      throw new Error("NanoGPT device code already used; run login again");
    }

    // 404: invalid code
    if (res.status === 404) {
      throw new Error("NanoGPT device code invalid");
    }

    throw new Error(`NanoGPT poll failed: HTTP ${res.status}`);
  }

  throw new Error("NanoGPT device code expired; run login again");
}

export async function nanogptLoginCommand(
  opts: { profileId?: string; yes?: boolean; setDefault?: boolean },
  runtime: RuntimeEnv,
) {
  if (!process.stdin.isTTY) {
    throw new Error("nanogpt login requires an interactive TTY.");
  }

  intro(stylePromptTitle("NanoGPT login"));

  const profileId = opts.profileId?.trim() || "nanogpt:default";
  const store = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: false,
  });

  if (store.profiles[profileId] && !opts.yes) {
    note(
      `Auth profile already exists: ${profileId}\nRe-running will overwrite it.`,
      stylePromptTitle("Existing credentials"),
    );
  }

  const spin = spinner();
  spin.start("Requesting device code from NanoGPT...");
  const device = await requestDeviceCode();
  spin.stop("Device code ready");

  note(
    [
      `Visit: ${device.verification_uri_complete || device.verification_uri}`,
      `Code: ${device.user_code}`,
    ].join("\n"),
    stylePromptTitle("Authorize"),
  );

  const expiresAt = Date.now() + device.expires_in * 1000;
  const intervalMs = device.interval ? device.interval * 1000 : DEFAULT_POLL_INTERVAL_MS;

  const polling = spinner();
  polling.start("Waiting for NanoGPT authorization...");
  const apiKey = await pollForApiKey({
    deviceCode: device.device_code,
    intervalMs,
    expiresAt,
  });
  polling.stop("NanoGPT API key acquired");

  // Store the API key
  await setNanoGptApiKey(apiKey);

  upsertAuthProfile({
    profileId,
    credential: {
      type: "api_key",
      provider: "nanogpt",
      key: apiKey,
    },
  });

  await updateConfig((cfg) => {
    let next = applyAuthProfileConfig(cfg, {
      provider: "nanogpt",
      profileId,
      mode: "api_key",
    });
    if (opts.setDefault) {
      next = applyNanoGptConfig(next);
    }
    return next;
  });

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (nanogpt/api_key)`);

  if (opts.setDefault) {
    runtime.log("Default model set to nanogpt/zai-org/glm-4.7");
  }

  outro("Done");
}
