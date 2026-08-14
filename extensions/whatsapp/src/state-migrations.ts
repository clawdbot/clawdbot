// Whatsapp plugin module implements state migrations behavior.
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import { fileExists } from "openclaw/plugin-sdk/security-runtime";
import { isWhatsAppBaileysAuthFileName } from "./creds-files.js";

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
    if (!entry.isFile() || !isWhatsAppBaileysAuthFileName(entry.name)) {
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
