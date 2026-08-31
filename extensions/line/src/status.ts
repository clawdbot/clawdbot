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
  collectIssuesForEnabledAccounts,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
  createDependentCredentialStatusIssueCollector,
} from "openclaw/plugin-sdk/status-helpers";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasLineCredentials } from "./account-helpers.js";
import type { LineProbeWebhookState, ResolvedLineAccount } from "./types.js";

const loadLineProbeRuntime = createLazyRuntimeModule(() => import("./probe.runtime.js"));

const collectLineCredentialIssues = createDependentCredentialStatusIssueCollector({
  channel: "line",
  dependencySourceKey: "tokenSource",
  missingPrimaryMessage: "LINE channel access token not configured",
  missingDependentMessage: "LINE channel secret not configured",
});

function readProbeWebhookState(probe: unknown): LineProbeWebhookState | undefined {
  if (!isRecord(probe) || !isRecord(probe.webhook)) {
    return undefined;
  }
  const { status } = probe.webhook;
  return status === "active" || status === "disabled" || status === "unset"
    ? { status }
    : undefined;
}

/**
 * What to tell an operator about a webhook LINE will not deliver to, or nothing when
 * it will. Startup and status both report this, and share one wording so the account
 * that logged the warning cannot describe itself differently when asked again.
 *
 * Each state names the action it needs, and only the action: a registered-but-off
 * webhook needs the console switch, an unregistered one needs the route this account
 * serves. Both name where to look rather than what is there — a registered URL, and an
 * opaque configured route, are strings an operator may be using as a shared secret, and
 * neither is needed to act: the console holds the first, and the operator's own config
 * holds the second.
 */
export function describeLineWebhookDelivery(params: {
  webhook: LineProbeWebhookState | undefined;
}): { message: string; fix: string } | undefined {
  const { webhook } = params;
  if (!webhook || webhook.status === "active") {
    return undefined;
  }
  const consoleTab = "the channel's Messaging API tab in the LINE Developers Console";
  return webhook.status === "disabled"
    ? {
        message:
          "LINE is not delivering webhook events: this channel's webhook URL is registered but switched off.",
        fix: `turn Use webhook on in ${consoleTab}`,
      }
    : {
        message:
          "LINE is not delivering webhook events: this channel has no webhook URL registered.",
        fix: `register your gateway's public HTTPS URL for the route in channels.line.webhookPath (default /line/webhook) in ${consoleTab}, then turn Use webhook on`,
      };
}

// LINE sends webhook events only while the console switch is on, and no API can turn
// it on, so a channel with a healthy token and dead inbound looks entirely fine.
// This is deliberately not `ingressUnavailable`: that flag means our own durable
// queue failed and is remedied by a restart, which cannot change a console setting.
function collectLineWebhookIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[] {
  return collectIssuesForEnabledAccounts({
    accounts,
    readAccount: (account) => (account.configured === false ? null : account),
    collectIssues: ({ account, accountId, issues }) => {
      const delivery = describeLineWebhookDelivery({
        webhook: readProbeWebhookState(account.probe),
      });
      if (delivery) {
        issues.push({ channel: "line", accountId, kind: "config", ...delivery });
      }
    },
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
      },
    }),
  });
