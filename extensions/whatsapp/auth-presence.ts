import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveUserPath } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveOAuthDir } from "openclaw/plugin-sdk/state-paths";
import { hasWebCredsSync } from "./src/creds-files.js";

type WhatsAppAuthPresenceParams =
  | {
      cfg: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
    }
  | OpenClawConfig;

function addAccountAuthDirs(
  authDirs: Set<string>,
  accountId: string,
  authDir: string | undefined,
  accountsRoot: string,
  env: NodeJS.ProcessEnv,
): void {
  authDirs.add(path.join(accountsRoot, normalizeAccountId(accountId)));
  const configuredAuthDir = authDir?.trim();
  if (configuredAuthDir) {
    authDirs.add(resolveUserPath(configuredAuthDir, env));
  }
}

function listWhatsAppAuthDirs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const oauthDir = resolveOAuthDir(env);
  const accountsRoot = path.join(oauthDir, "whatsapp");
  const channel = cfg.channels?.whatsapp;
  const authDirs = new Set<string>([oauthDir, path.join(accountsRoot, DEFAULT_ACCOUNT_ID)]);

  addAccountAuthDirs(authDirs, DEFAULT_ACCOUNT_ID, undefined, accountsRoot, env);

  if (channel?.defaultAccount?.trim()) {
    addAccountAuthDirs(
      authDirs,
      channel.defaultAccount,
      channel.accounts?.[channel.defaultAccount]?.authDir,
      accountsRoot,
      env,
    );
  }

  const accounts = channel?.accounts;
  if (accounts) {
    for (const [accountId, account] of Object.entries(accounts)) {
      addAccountAuthDirs(authDirs, accountId, account?.authDir, accountsRoot, env);
    }
  }

  try {
    const entries = fs.readdirSync(accountsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        authDirs.add(path.join(accountsRoot, entry.name));
      }
    }
  } catch {
    // Missing directories mean no auth state.
  }

  return [...authDirs];
}

export function hasAnyWhatsAppAuth(
  params: WhatsAppAuthPresenceParams,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cfg = params && typeof params === "object" && "cfg" in params ? params.cfg : params;
  const resolvedEnv =
    params && typeof params === "object" && "cfg" in params ? (params.env ?? env) : env;
  return listWhatsAppAuthDirs(cfg, resolvedEnv).some((authDir) => hasWebCredsSync(authDir));
}
