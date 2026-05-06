import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import { statRegularFileSync } from "openclaw/plugin-sdk/security-runtime";

function fileExists(pathValue: string): boolean {
  try {
    return !statRegularFileSync(pathValue).missing;
  } catch {
    return false;
  }
}

function isLegacyWhatsAppAuthFile(name: string): boolean {
  if (name === "creds.json" || name === "creds.json.bak") {
    return true;
  }
  if (!name.endsWith(".json")) {
    return false;
  }
  return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
}

export function detectWhatsAppLegacyStateMigrations(params: {
  oauthDir: string;
}): ChannelLegacyStateMigrationPlan[] {
  const targetDir = path.join(params.oauthDir, "whatsapp", DEFAULT_ACCOUNT_ID);
  const entries = (() => {
    try {
      return fs.readdirSync(params.oauthDir, { withFileTypes: true });
    } catch {
      return [];
    }
  })();

  return entries.flatMap((entry) => {
    if (!entry.isFile() || entry.name === "oauth.json" || !isLegacyWhatsAppAuthFile(entry.name)) {
      return [];
    }
    const sourcePath = path.join(params.oauthDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (fileExists(targetPath)) {
      return [];
    }
    return [
      {
        kind: "move" as const,
        label: `WhatsApp auth ${entry.name}`,
        sourcePath,
        targetPath,
      },
    ];
  });
}
