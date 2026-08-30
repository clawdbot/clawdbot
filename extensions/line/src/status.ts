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
  const { status, endpoint } = probe.webhook;
  if (status === "unset") {
    return { status };
  }
  return (status === "active" || status === "disabled") && typeof endpoint === "string"
    ? { status, endpoint }
    : undefined;
}

const LINE_WEBHOOK_DELIVERY_FIX =
  "open the channel's Messaging API tab in the LINE Developers Console, set the webhook URL to your gateway's /line/webhook path, and turn Use webhook on";

/**
 * What to tell an operator about a webhook LINE will not deliver to, or nothing when
 * it will. Startup and status both report this, and share one wording so the account
 * that logged the warning cannot describe itself differently when asked again.
 */
export function describeLineWebhookDelivery(
  webhook: LineProbeWebhookState | undefined,
): { message: string; fix: string } | undefined {
  if (!webhook || webhook.status === "active") {
    return undefined;
  }
  return {
    message:
      webhook.status === "disabled"
        ? "LINE is not delivering webhook events: this channel's webhook URL is registered but switched off."
        : "LINE is not delivering webhook events: this channel has no webhook URL registered.",
    fix: LINE_WEBHOOK_DELIVERY_FIX,
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
    const delivery = describeLineWebhookDelivery(readProbeWebhookState(account.probe));
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
      },
    }),
  });
