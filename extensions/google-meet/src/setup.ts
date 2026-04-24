import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GoogleMeetConfig } from "./config.js";

type SetupCheck = {
  id: string;
  ok: boolean;
  message: string;
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

export function getGoogleMeetSetupStatus(config: GoogleMeetConfig): {
  ok: boolean;
  checks: SetupCheck[];
} {
  const checks: SetupCheck[] = [];

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

  if (config.chrome.browserProfile) {
    const profilePath = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      config.chrome.browserProfile,
    );
    checks.push({
      id: "chrome-profile",
      ok: fs.existsSync(profilePath),
      message: fs.existsSync(profilePath)
        ? "Chrome profile found"
        : `Chrome profile missing: ${config.chrome.browserProfile}`,
    });
  } else {
    checks.push({
      id: "chrome-profile",
      ok: true,
      message: "Chrome profile not pinned; default signed-in profile will be used",
    });
  }

  checks.push({
    id: "audio-bridge",
    ok: Boolean(
      config.chrome.audioBridgeCommand ||
      (config.chrome.audioInputCommand && config.chrome.audioOutputCommand),
    ),
    message: config.chrome.audioBridgeCommand
      ? "Chrome audio bridge command configured"
      : config.chrome.audioInputCommand && config.chrome.audioOutputCommand
        ? "Chrome command-pair realtime audio bridge configured"
        : "Chrome realtime audio bridge not configured",
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}
