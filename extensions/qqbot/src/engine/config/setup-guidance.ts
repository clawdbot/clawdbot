import { isQQBotTokenAuthenticationFailure } from "../api/auth-errors.js";
import { DEFAULT_ACCOUNT_ID } from "./resolve.js";

const QQBOT_DOCS_URL = "https://docs.openclaw.ai/channels/qqbot";
const QQBOT_OPEN_PLATFORM_URL = "https://q.qq.com/";

function qqbotAuthGuidance(): string {
  return `Check the QQBot account appId and clientSecret (or clientSecretFile) in OpenClaw and verify the credentials in QQ Open Platform at ${QQBOT_OPEN_PLATFORM_URL}. See ${QQBOT_DOCS_URL}`;
}

export function qqbotNetworkGuidance(): string {
  return `Check network connectivity and DNS, and verify the server IP whitelist in QQ Open Platform at ${QQBOT_OPEN_PLATFORM_URL}. See ${QQBOT_DOCS_URL}`;
}

export function qqbotApiGuidance(httpStatus: number, bizCode?: number): string {
  return isQQBotTokenAuthenticationFailure(httpStatus, bizCode)
    ? qqbotAuthGuidance()
    : `See ${QQBOT_DOCS_URL} for QQBot API troubleshooting`;
}

export function qqbotNotConfiguredMessage(accountId: string): string {
  const guidance =
    accountId === DEFAULT_ACCOUNT_ID
      ? `Set channels.qqbot.appId and clientSecret (or clientSecretFile), or set QQBOT_APP_ID and QQBOT_CLIENT_SECRET. See ${QQBOT_DOCS_URL}`
      : `Set channels.qqbot.accounts.${accountId}.appId and clientSecret (or clientSecretFile). See ${QQBOT_DOCS_URL}`;
  return `QQBot not configured (missing appId or clientSecret). ${guidance}`;
}

export function qqbotTokenFailureMessage(detail: string): string {
  return `Failed to get QQBot access_token. ${qqbotAuthGuidance()}. Open platform response: ${detail}`;
}
