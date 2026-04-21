/**
 * QQBot setup business logic (pure layer).
 * QQBot setup 相关纯业务逻辑。
 *
 * Token parsing, input validation, and setup config application.
 * All functions are framework-agnostic and operate on plain objects.
 */

import { applyAccountConfig } from "./resolve.js";
import { DEFAULT_ACCOUNT_ID } from "./resolve.js";

/** Parse an inline "appId:clientSecret" token string. */
export function parseInlineToken(token: string): { appId: string; clientSecret: string } | null {
  const colonIdx = token.indexOf(":");
  if (colonIdx <= 0 || colonIdx === token.length - 1) {
    return null;
  }

  const appId = token.slice(0, colonIdx).trim();
  const clientSecret = token.slice(colonIdx + 1).trim();
  if (!appId || !clientSecret) {
    return null;
  }

  return { appId, clientSecret };
}

export interface SetupInput {
  token?: string;
  tokenFile?: string;
  useEnv?: boolean;
  name?: string;
}

/** Validate setup input for a QQBot account. Returns an error string or null. */
export function validateSetupInput(accountId: string, input: SetupInput): string | null {
  if (!input.token && !input.tokenFile && !input.useEnv) {
    return "QQBot requires --token (format: appId:clientSecret) or --use-env";
  }

  if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
    return "QQBot --use-env only supports the default account";
  }

  if (input.token && !parseInlineToken(input.token)) {
    return "QQBot --token must be in appId:clientSecret format";
  }

  return null;
}

/** Apply setup input to account config. Returns updated config. */
export function applySetupAccountConfig(
  cfg: Record<string, unknown>,
  accountId: string,
  input: SetupInput,
): Record<string, unknown> {
  if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
    return cfg;
  }

  let appId = "";
  let clientSecret = "";

  if (input.token) {
    const parsed = parseInlineToken(input.token);
    if (!parsed) {
      return cfg;
    }
    appId = parsed.appId;
    clientSecret = parsed.clientSecret;
  }

  if (!appId && !input.tokenFile && !input.useEnv) {
    return cfg;
  }

  return applyAccountConfig(cfg, accountId, {
    appId,
    clientSecret,
    clientSecretFile: input.tokenFile,
    name: input.name,
  });
}
