// Synology Chat plugin module implements gateway runtime behavior.
import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { dispatchSynologyChatInboundEvent } from "./inbound-event.js";
import type { ResolvedSynologyChatAccount } from "./types.js";
import {
  createWebhookHandler,
  processSynologyWebhookIngressEvent,
  type WebhookHandlerDeps,
} from "./webhook-handler.js";
import { createSynologyIngressMonitor } from "./webhook-ingress.js";

const CHANNEL_ID = "synology-chat";

type SynologyGatewayLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};
type SynologyGatewayStartupIssueCode =
  | "disabled"
  | "missing-credentials"
  | "empty-allowlist"
  | "empty-open-allowlist"
  | "inherited-shared-webhook-path"
  | "duplicate-webhook-path";
type SynologyGatewayStartupIssue = {
  code: SynologyGatewayStartupIssueCode;
  logLevel: "info" | "warn";
  message: string;
};

const activeRouteCleanups = new Map<string, () => Promise<void>>();

function buildStartupIssue(
  code: SynologyGatewayStartupIssueCode,
  message: string,
  logLevel: "info" | "warn" = "warn",
): SynologyGatewayStartupIssue {
  return { code, logLevel, message };
}

function logStartupIssues(
  log: SynologyGatewayLog | undefined,
  issues: SynologyGatewayStartupIssue[],
) {
  for (const issue of issues) {
    const message = `Synology Chat ${issue.message}`;
    if (issue.logLevel === "info") {
      log?.info?.(message);
      continue;
    }
    log?.warn?.(message);
  }
}

function getRouteKey(account: ResolvedSynologyChatAccount): string {
  return `${account.accountId}:${account.webhookPath}`;
}

function createUnknownArgsLogAdapter(
  log?: SynologyGatewayLog,
): WebhookHandlerDeps["log"] | undefined {
  if (!log) {
    return undefined;
  }
  const formatArg = (value: unknown): string =>
    typeof value === "string" ? value : value instanceof Error ? value.message : "";
  const formatArgs = (args: unknown[]): string => args.map(formatArg).filter(Boolean).join(": ");
  return {
    info: (...args) => log.info?.(formatArgs(args)),
    warn: (...args) => log.warn?.(formatArgs(args)),
    error: (...args) => log.error?.(formatArgs(args)),
  };
}

function collectSynologyGatewayStartupIssues(params: {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
  accountId: string;
}): SynologyGatewayStartupIssue[] {
  const { cfg, account, accountId } = params;
  const issues: SynologyGatewayStartupIssue[] = [];

  if (!account.enabled) {
    issues.push(
      buildStartupIssue("disabled", `account ${accountId} is disabled, skipping`, "info"),
    );
    return issues;
  }
  if (!account.token || !account.incomingUrl) {
    issues.push(
      buildStartupIssue(
        "missing-credentials",
        `account ${accountId} not fully configured (missing token or incomingUrl)`,
      ),
    );
  }
  if (account.dmPolicy === "allowlist" && account.allowedUserIds.length === 0) {
    issues.push(
      buildStartupIssue(
        "empty-allowlist",
        `account ${accountId} has dmPolicy=allowlist but empty allowedUserIds; refusing to start route`,
      ),
    );
  }
  if (account.dmPolicy === "open" && account.allowedUserIds.length === 0) {
    issues.push(
      buildStartupIssue(
        "empty-open-allowlist",
        `account ${accountId} has dmPolicy=open but empty allowedUserIds; add allowedUserIds=["*"] for public DMs or set explicit user IDs`,
      ),
    );
  }

  const accountIds = listAccountIds(cfg);
  const isMultiAccount = accountIds.length > 1;
  if (
    isMultiAccount &&
    accountId !== DEFAULT_ACCOUNT_ID &&
    account.webhookPathSource === "inherited-base" &&
    !account.dangerouslyAllowInheritedWebhookPath
  ) {
    issues.push(
      buildStartupIssue(
        "inherited-shared-webhook-path",
        `account ${accountId} must set an explicit webhookPath in multi-account setups; refusing inherited shared path. Set channels.synology-chat.accounts.${accountId}.webhookPath or opt in with dangerouslyAllowInheritedWebhookPath=true.`,
      ),
    );
  }

  const conflictingAccounts = accountIds.filter((candidateId) => {
    if (candidateId === accountId) {
      return false;
    }
    const candidate = resolveAccount(cfg, candidateId);
    return candidate.enabled && candidate.webhookPath === account.webhookPath;
  });
  if (conflictingAccounts.length > 0) {
    issues.push(
      buildStartupIssue(
        "duplicate-webhook-path",
        `account ${accountId} conflicts on webhookPath ${account.webhookPath} with ${conflictingAccounts.join(", ")}; refusing to start ambiguous shared route.`,
      ),
    );
  }

  return issues;
}

export function collectSynologyGatewayRoutingWarnings(params: {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
}): string[] {
  return collectSynologyGatewayStartupIssues({
    cfg: params.cfg,
    account: params.account,
    accountId: params.account.accountId,
  })
    .filter(
      (issue) =>
        issue.code === "inherited-shared-webhook-path" || issue.code === "duplicate-webhook-path",
    )
    .map((issue) => `- Synology Chat: ${issue.message}`);
}

export function validateSynologyGatewayAccountStartup(params: {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
  accountId: string;
  log?: SynologyGatewayLog;
}): { ok: true } | { ok: false } {
  const issues = collectSynologyGatewayStartupIssues(params);
  if (issues.length > 0) {
    logStartupIssues(params.log, issues);
    return { ok: false };
  }
  return { ok: true };
}

export async function registerSynologyWebhookRoute(params: {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
  accountId: string;
  log?: SynologyGatewayLog;
  abortSignal?: AbortSignal;
}): Promise<() => Promise<void>> {
  const { cfg, account, log } = params;
  const routeKey = getRouteKey(account);
  const previousCleanup = activeRouteCleanups.get(routeKey);
  if (previousCleanup) {
    log?.info?.(`Deregistering stale route before re-registering: ${account.webhookPath}`);
    await previousCleanup();
  }

  const logAdapter = createUnknownArgsLogAdapter(log);
  const ingress = createSynologyIngressMonitor({
    accountId: account.accountId,
    runtime: {
      error: (message) => log?.error?.(message),
    },
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    dispatch: async (rawEvent, lifecycle) => {
      await processSynologyWebhookIngressEvent({
        account,
        rawEvent,
        lifecycle,
        log: logAdapter,
        deliver: async (msg, turnAdoptionLifecycle) => {
          await dispatchSynologyChatInboundEvent({
            account,
            msg,
            log: logAdapter,
            turnAdoptionLifecycle,
          });
        },
      });
    },
  });
  ingress.start();
  const handler = createWebhookHandler({
    account,
    trustedProxies: cfg.gateway?.trustedProxies,
    allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
    receive: ingress.receive,
    log: logAdapter,
  });
  let unregister: () => void;
  try {
    unregister = registerPluginHttpRoute({
      path: account.webhookPath,
      auth: "plugin",
      pluginId: CHANNEL_ID,
      accountId: account.accountId,
      log: (msg: string) => log?.info?.(msg),
      handler,
    });
  } catch (error) {
    await ingress.stop();
    throw error;
  }
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      try {
        unregister();
      } finally {
        try {
          await ingress.stop();
        } finally {
          // A replacement route may already own this key; never delete its cleanup.
          if (activeRouteCleanups.get(routeKey) === cleanup) {
            activeRouteCleanups.delete(routeKey);
          }
        }
      }
    })();
    return cleanupPromise;
  };
  activeRouteCleanups.set(routeKey, cleanup);
  return cleanup;
}
