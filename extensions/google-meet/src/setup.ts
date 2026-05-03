import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";

type SetupCheck = {
  id: string;
  ok: boolean;
  message: string;
};

type GoogleMeetSetupStatus = {
  ok: boolean;
  checks: SetupCheck[];
};

function resolveUserPath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function isProviderUnreachableWebhookUrl(webhookUrl: string): boolean {
  try {
    const parsed = new URL(webhookUrl);
    return isBlockedHostnameOrIp(parsed.hostname);
  } catch {
    return false;
  }
}

function getVoiceCallWebhookExposureCheck(voiceCallConfig: Record<string, unknown>): SetupCheck {
  const publicUrl = normalizeOptionalString(voiceCallConfig.publicUrl);
  const tunnel = asRecord(voiceCallConfig.tunnel);
  const tailscale = asRecord(voiceCallConfig.tailscale);
  const tunnelProvider = normalizeOptionalString(tunnel.provider);
  const tailscaleMode = normalizeOptionalString(tailscale.mode);

  if (publicUrl) {
    const ok = !isProviderUnreachableWebhookUrl(publicUrl);
    return {
      id: "twilio-voice-call-webhook",
      ok,
      message: ok
        ? `Voice-call public webhook URL configured: ${publicUrl}`
        : `Voice-call publicUrl is local/private and cannot be reached by Twilio: ${publicUrl}`,
    };
  }

  if (tunnelProvider && tunnelProvider !== "none") {
    return {
      id: "twilio-voice-call-webhook",
      ok: true,
      message: "Voice-call webhook exposure configured through tunnel",
    };
  }

  if (tailscaleMode && tailscaleMode !== "off") {
    return {
      id: "twilio-voice-call-webhook",
      ok: true,
      message: "Voice-call webhook exposure configured through Tailscale",
    };
  }

  return {
    id: "twilio-voice-call-webhook",
    ok: false,
    message:
      "Set plugins.entries.voice-call.config.publicUrl or configure voice-call tunnel/tailscale exposure for Twilio dialing",
  };
}

export function getGoogleMeetSetupStatus(config: GoogleMeetConfig): {
  ok: boolean;
  checks: SetupCheck[];
};
export function getGoogleMeetSetupStatus(
  config: GoogleMeetConfig,
  options?: {
    env?: NodeJS.ProcessEnv;
    fullConfig?: unknown;
    mode?: GoogleMeetMode;
    transport?: GoogleMeetTransport;
    twilioDialInNumber?: string;
  },
): {
  ok: boolean;
  checks: SetupCheck[];
};
export function getGoogleMeetSetupStatus(
  config: GoogleMeetConfig,
  options?: {
    env?: NodeJS.ProcessEnv;
    fullConfig?: unknown;
    mode?: GoogleMeetMode;
    transport?: GoogleMeetTransport;
    twilioDialInNumber?: string;
  },
) {
  const checks: SetupCheck[] = [];
  const env = options?.env ?? process.env;
  const fullConfig = asRecord(options?.fullConfig);
  const mode = options?.mode ?? config.defaultMode;
  const transport = options?.transport ?? config.defaultTransport;
  const needsChromeRealtimeAudio =
    mode === "realtime" && (transport === "chrome" || transport === "chrome-node");
  const pluginEntries = asRecord(asRecord(fullConfig.plugins).entries);
  const pluginAllow = asRecord(fullConfig.plugins).allow;
  const voiceCallEntry = asRecord(pluginEntries["voice-call"]);
  const voiceCallConfig = asRecord(voiceCallEntry.config);
  const voiceCallTwilioConfig = asRecord(voiceCallConfig.twilio);

  if (config.auth.tokenPath) {
    const tokenPath = resolveUserPath(config.auth.tokenPath);
    checks.push({
      id: "google-oauth-token",
      ok: fs.existsSync(tokenPath),
      message: fs.existsSync(tokenPath)
        ? "Google OAuth token file found"
        : `Google OAuth token file missing at ${config.auth.tokenPath}`,
    });
  } else {
    checks.push({
      id: "google-oauth-token",
      ok: true,
      message: "Google OAuth token path not configured; Chrome profile auth will be used",
    });
  }

  checks.push({
    id: "chrome-profile",
    ok: true,
    message: config.chrome.browserProfile
      ? "Local Chrome uses the OpenClaw browser profile; chrome.browserProfile is passed to chrome-node hosts"
      : "Local Chrome uses the OpenClaw browser profile; configure browser.defaultProfile to choose another profile",
  });

  if (needsChromeRealtimeAudio) {
    checks.push({
      id: "audio-bridge",
      ok: Boolean(
        config.chrome.audioBridgeCommand ||
        (config.chrome.audioInputCommand && config.chrome.audioOutputCommand),
      ),
      message: config.chrome.audioBridgeCommand
        ? "Chrome audio bridge command configured"
        : config.chrome.audioInputCommand && config.chrome.audioOutputCommand
          ? `Chrome command-pair realtime audio bridge configured (${config.chrome.audioFormat})`
          : "Chrome realtime audio bridge not configured",
    });
  } else if (transport === "chrome" || transport === "chrome-node") {
    checks.push({
      id: "audio-bridge",
      ok: true,
      message: "Chrome observe-only mode does not require a realtime audio bridge",
    });
  }

  checks.push({
    id: "guest-join-defaults",
    ok: Boolean(
      config.chrome.guestName && config.chrome.autoJoin && config.chrome.reuseExistingTab,
    ),
    message:
      config.chrome.guestName && config.chrome.autoJoin && config.chrome.reuseExistingTab
        ? "Guest auto-join and tab reuse defaults are enabled"
        : "Set chrome.guestName, chrome.autoJoin, and chrome.reuseExistingTab for unattended guest joins",
  });

  checks.push({
    id: "chrome-node-target",
    ok: config.defaultTransport !== "chrome-node" || Boolean(config.chromeNode.node),
    message:
      config.defaultTransport === "chrome-node" && !config.chromeNode.node
        ? "chrome-node default should pin chromeNode.node when multiple nodes may be connected"
        : config.chromeNode.node
          ? `Chrome node pinned to ${config.chromeNode.node}`
          : "Chrome node not pinned; automatic selection works when exactly one capable node is connected",
  });

  if (needsChromeRealtimeAudio) {
    checks.push({
      id: "intro-after-in-call",
      ok: config.chrome.waitForInCallMs > 0,
      message:
        config.chrome.waitForInCallMs > 0
          ? `Realtime intro waits up to ${config.chrome.waitForInCallMs}ms for the Meet tab to be in-call`
          : "Set chrome.waitForInCallMs to delay realtime intro until the Meet tab is in-call",
    });
  }

  if (transport === "twilio") {
    const hasRequestDialPlan = Boolean(options?.twilioDialInNumber);
    const hasDefaultDialPlan = Boolean(config.twilio.defaultDialInNumber);
    const hasDialPlan = hasRequestDialPlan || hasDefaultDialPlan;
    checks.push({
      id: "twilio-dial-plan",
      ok: hasDialPlan,
      message: hasRequestDialPlan
        ? "Twilio request includes a Meet dial-in number"
        : hasDefaultDialPlan
          ? "Twilio default Meet dial-in number is configured"
          : "Twilio joins require a Meet dial-in phone number; pass dialInNumber with optional pin/dtmfSequence or configure twilio.defaultDialInNumber",
    });
  }

  const shouldCheckTwilioDelegation =
    config.voiceCall.enabled &&
    (transport === "twilio" ||
      Boolean(config.twilio.defaultDialInNumber) ||
      Object.hasOwn(pluginEntries, "voice-call"));
  if (shouldCheckTwilioDelegation) {
    const voiceCallAllowed = !Array.isArray(pluginAllow) || pluginAllow.includes("voice-call");
    const voiceCallEnabled = voiceCallEntry.enabled !== false;
    checks.push({
      id: "twilio-voice-call-plugin",
      ok: voiceCallAllowed && voiceCallEnabled,
      message:
        voiceCallAllowed && voiceCallEnabled
          ? "Twilio transport can delegate dialing to the voice-call plugin"
          : "Enable plugins.entries.voice-call and include voice-call in plugins.allow for Twilio dialing",
    });

    const provider = normalizeOptionalString(voiceCallConfig.provider) ?? "twilio";
    if (provider === "twilio") {
      const accountSid = normalizeOptionalString(voiceCallTwilioConfig.accountSid);
      const authToken = normalizeOptionalString(voiceCallTwilioConfig.authToken);
      const fromNumber = normalizeOptionalString(voiceCallConfig.fromNumber);
      const twilioReady = Boolean(
        (accountSid || env.TWILIO_ACCOUNT_SID) &&
        (authToken || env.TWILIO_AUTH_TOKEN) &&
        (fromNumber || env.TWILIO_FROM_NUMBER),
      );
      checks.push({
        id: "twilio-voice-call-credentials",
        ok: twilioReady,
        message: twilioReady
          ? "Twilio voice-call credentials are configured"
          : "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER or configure voice-call Twilio credentials",
      });
      checks.push(getVoiceCallWebhookExposureCheck(voiceCallConfig));
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export function addGoogleMeetSetupCheck(
  status: GoogleMeetSetupStatus,
  check: SetupCheck,
): GoogleMeetSetupStatus {
  const checks = [...status.checks, check];
  return {
    ok: checks.every((item) => item.ok),
    checks,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
