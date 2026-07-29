/**
 * Maps ClickClack senders and conversations onto the shared channel ingress
 * allowlist/command authorization contract.
 */
import {
  resolveStableChannelMessageIngress,
  type StableChannelIngressIdentityParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getClickClackRuntime } from "./runtime.js";
import type { ClickClackMessage, CoreConfig, ResolvedClickClackAccount } from "./types.js";

const CHANNEL_ID = "clickclack" as const;

function normalizeClickClackUserId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutProvider = trimmed.replace(/^(clickclack|cc):/i, "").trim();
  const directTarget = withoutProvider.match(/^dm:(.+)$/i);
  return directTarget?.[1]?.trim() || withoutProvider || null;
}

const clickClackIngressIdentity = {
  key: "user-id",
  normalizeEntry: normalizeClickClackUserId,
  normalizeSubject: normalizeClickClackUserId,
  isWildcardEntry: (entry) => normalizeClickClackUserId(entry) === "*",
  entryIdPrefix: "clickclack-user",
} satisfies StableChannelIngressIdentityParams;

/**
 * Dispatch and command authorization decision for one inbound ClickClack
 * message.
 */
export type ClickClackInboundAccess = {
  shouldDispatch: boolean;
  commandAuthorized: boolean;
};

/**
 * Resolves whether a ClickClack message should enter the agent pipeline and
 * whether its command-style body may run tools.
 */
export async function resolveClickClackInboundAccess(params: {
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  message: ClickClackMessage;
}): Promise<ClickClackInboundAccess> {
  const runtime = getClickClackRuntime();
  const isDirect = Boolean(params.message.direct_conversation_id);
  const cfg = params.config as OpenClawConfig;
  const shouldCheckCommand = runtime.channel.commands.shouldComputeCommandAuthorized(
    params.message.body,
    cfg,
  );
  const resolved = await resolveStableChannelMessageIngress({
    channelId: CHANNEL_ID,
    accountId: params.account.accountId,
    identity: clickClackIngressIdentity,
    cfg,
    subject: { stableId: params.message.author_id },
    conversation: {
      kind: isDirect ? "direct" : "group",
      id: isDirect
        ? (params.message.direct_conversation_id ?? params.message.author_id)
        : (params.message.channel_id ?? params.message.thread_root_id),
    },
    allowFrom: params.account.allowFrom,
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    command: shouldCheckCommand
      ? {
          cfg,
          modeWhenAccessGroupsOff: "configured",
        }
      : false,
  });

  return {
    shouldDispatch: resolved.ingress.admission === "dispatch",
    commandAuthorized: resolved.commandAccess.requested
      ? resolved.commandAccess.authorized
      : resolved.senderAccess.allowed,
  };
}
