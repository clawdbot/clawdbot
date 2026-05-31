import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsWebhookHandler, type SmsWebhookHandlerParams } from "./webhook.js";

const CHANNEL_ID = "sms";

const activeRoutes = new Map<string, () => void>();
const activeRoutePaths = new Map<string, string>();

type SmsGatewayLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

function routeKey(account: ResolvedSmsAccount): string {
  return `${account.accountId}:${normalizeWebhookPath(account.webhookPath)}`;
}

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function collectSmsStartupWarnings(account: ResolvedSmsAccount): string[] {
  const warnings: string[] = [];
  if (
    !account.accountSid ||
    !account.authToken ||
    (!account.fromNumber && !account.messagingServiceSid)
  ) {
    warnings.push(
      "- SMS: accountSid, authToken, and fromNumber or messagingServiceSid are required.",
    );
  }
  if (!account.publicWebhookUrl && !account.dangerouslyDisableSignatureValidation) {
    warnings.push(
      "- SMS: publicWebhookUrl is required for Twilio signature validation. Set dangerouslyDisableSignatureValidation=true only for local testing.",
    );
  }
  if (account.dmPolicy === "allowlist" && account.allowFrom.length === 0) {
    warnings.push("- SMS: dmPolicy=allowlist with empty allowFrom rejects every sender.");
  }
  if (account.dmPolicy === "open" && !account.allowFrom.includes("*")) {
    warnings.push('- SMS: dmPolicy=open should set allowFrom=["*"] or explicit sender numbers.');
  }
  return warnings;
}

export function registerSmsWebhookRoute(params: {
  cfg: SmsWebhookHandlerParams["cfg"];
  account: ResolvedSmsAccount;
  channelRuntime: SmsWebhookHandlerParams["channelRuntime"];
  log?: SmsGatewayLog;
}): () => void {
  const key = routeKey(params.account);
  const webhookPath = normalizeWebhookPath(params.account.webhookPath);
  const currentPathOwner = activeRoutePaths.get(webhookPath);
  if (currentPathOwner && currentPathOwner !== params.account.accountId) {
    throw new Error(
      `SMS webhook path ${webhookPath} is already registered by account ${currentPathOwner}; configure a distinct webhookPath for account ${params.account.accountId}.`,
    );
  }
  activeRoutes.get(key)?.();
  activeRoutePaths.delete(webhookPath);
  const unregister = registerPluginHttpRoute({
    path: webhookPath,
    auth: "plugin",
    pluginId: CHANNEL_ID,
    accountId: params.account.accountId,
    log: (msg) => params.log?.info?.(msg),
    handler: createSmsWebhookHandler(params),
  });
  activeRoutes.set(key, unregister);
  activeRoutePaths.set(webhookPath, params.account.accountId);
  return () => {
    unregister();
    activeRoutes.delete(key);
    if (activeRoutePaths.get(webhookPath) === params.account.accountId) {
      activeRoutePaths.delete(webhookPath);
    }
  };
}

export async function startSmsGatewayAccount(params: {
  cfg: SmsWebhookHandlerParams["cfg"];
  account: ResolvedSmsAccount;
  channelRuntime: SmsWebhookHandlerParams["channelRuntime"];
  abortSignal: AbortSignal;
  log?: SmsGatewayLog;
}) {
  if (!params.account.enabled) {
    params.log?.info?.(`SMS account ${params.account.accountId} is disabled`);
    return waitUntilAbort(params.abortSignal);
  }
  const warnings = collectSmsStartupWarnings(params.account);
  if (warnings.some((warning) => warning.includes("required"))) {
    for (const warning of warnings) {
      params.log?.warn?.(warning);
    }
    return waitUntilAbort(params.abortSignal);
  }
  for (const warning of warnings) {
    params.log?.warn?.(warning);
  }
  const unregister = registerSmsWebhookRoute(params);
  params.log?.info?.(
    `Registered SMS webhook route ${params.account.webhookPath} for account ${params.account.accountId}`,
  );
  return waitUntilAbort(params.abortSignal, unregister);
}
