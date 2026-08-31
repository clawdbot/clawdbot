// Line plugin module implements status behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  buildTokenChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
  createDependentCredentialStatusIssueCollector,
} from "openclaw/plugin-sdk/status-helpers";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasLineCredentials } from "./account-helpers.js";
import type { LineProbeWebhookState, ResolvedLineAccount } from "./types.js";
import { LINE_DEFAULT_WEBHOOK_PATH, resolveLineWebhookPath } from "./webhook-utils.js";

const loadLineProbeRuntime = createLazyRuntimeModule(() => import("./probe.runtime.js"));

const collectLineCredentialIssues = createDependentCredentialStatusIssueCollector({
  channel: "line",
  dependencySourceKey: "tokenSource",
  missingPrimaryMessage: "LINE channel access token not configured",
  missingDependentMessage: "LINE channel secret not configured",
});

/** The resolved route this account serves, published by resolveAccountSnapshot below.
 *  Snapshots built elsewhere may not carry it, so the account's own default stands in. */
function readSnapshotWebhookPath(account: ChannelAccountSnapshot): string {
  return account.webhookPath?.trim() ? account.webhookPath : LINE_DEFAULT_WEBHOOK_PATH;
}

function readProbeWebhookState(probe: unknown): LineProbeWebhookState | undefined {
  if (!isRecord(probe) || !isRecord(probe.webhook)) {
    return undefined;
  }
  const { status, endpoint } = probe.webhook;
  if (status === "unset") {
    return { status };
  }
  // An empty endpoint would render "turn Use webhook on for  in ..." — a state LINE
  // cannot actually return, but the fix text is only useful when it names a URL.
  return (status === "active" || status === "disabled") && typeof endpoint === "string" && endpoint
    ? { status, endpoint }
    : undefined;
}

/**
 * What to tell an operator about a webhook LINE will not deliver to, or nothing when
 * it will. Startup and status both report this, and share one wording so the account
 * that logged the warning cannot describe itself differently when asked again.
 *
 * Each state names the fact it actually holds: a registered-but-off webhook already
 * has a URL LINE handed back, while an unregistered one needs the route this account's
 * monitor listens on. Naming a route the account does not serve would leave the bot
 * silent while the warning claims it is fixed.
 */
export function describeLineWebhookDelivery(params: {
  webhook: LineProbeWebhookState | undefined;
  webhookPath: string;
}): { message: string; fix: string } | undefined {
  const { webhook, webhookPath } = params;
  if (!webhook || webhook.status === "active") {
    return undefined;
  }
  const consoleTab = "the channel's Messaging API tab in the LINE Developers Console";
  return webhook.status === "disabled"
    ? {
        message:
          "LINE is not delivering webhook events: this channel's webhook URL is registered but switched off.",
        fix: `turn Use webhook on for ${webhook.endpoint} in ${consoleTab}`,
      }
    : {
        message:
          "LINE is not delivering webhook events: this channel has no webhook URL registered.",
        fix: `register your gateway's public HTTPS URL ending in ${webhookPath} in ${consoleTab}, then turn Use webhook on`,
      };
}

// LINE sends webhook events only while the console switch is on, and no API can turn
// it on, so a channel with a healthy token and dead inbound looks entirely fine.
// This is deliberately not `ingressUnavailable`: that flag means our own durable
// queue failed and is remedied by a restart, which cannot change a console setting.
function collectLineWebhookIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[] {
  return accounts.flatMap((account) => {
    if (account.enabled === false || account.configured === false) {
      return [];
    }
    const delivery = describeLineWebhookDelivery({
      webhook: readProbeWebhookState(account.probe),
      webhookPath: readSnapshotWebhookPath(account),
    });
    return delivery
      ? [
          {
            channel: "line" as const,
            accountId: account.accountId,
            kind: "config" as const,
            ...delivery,
          },
        ]
      : [];
  });
}

export const lineStatusAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["status"]> =
  createComputedAccountStatusAdapter<ResolvedLineAccount>({
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => [
      ...collectLineCredentialIssues(accounts),
      ...collectLineWebhookIssues(accounts),
    ],
    buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
    probeAccount: async ({ account, timeoutMs }) =>
      await (await loadLineProbeRuntime()).probeLineBot(account.channelAccessToken, timeoutMs),
    resolveAccountSnapshot: ({ account }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: hasLineCredentials(account),
      extra: {
        tokenSource: account.tokenSource,
        signingSecretSource: account.signingSecretSource,
        tokenStatus: account.tokenStatus,
        signingSecretStatus: account.signingSecretStatus,
        mode: "webhook",
        webhookPath: resolveLineWebhookPath(account.config.webhookPath),
      },
    }),
  });
