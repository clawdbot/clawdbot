import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  listBlueBubblesAccountIds,
  type ResolvedBlueBubblesAccount,
  resolveBlueBubblesAccount,
  resolveDefaultBlueBubblesAccountId,
} from "./accounts.js";
import { BlueBubblesChannelConfigSchema } from "./config-schema.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { normalizeBlueBubblesHandle } from "./targets.js";

export const bluebubblesMeta = {
  id: "bluebubbles",
  label: "BlueBubbles",
  selectionLabel: "BlueBubbles (macOS app)",
  detailLabel: "BlueBubbles",
  docsPath: "/channels/bluebubbles",
  docsLabel: "bluebubbles",
  blurb: "iMessage via the BlueBubbles mac app + REST API.",
  systemImage: "bubble.left.and.text.bubble.right",
  aliases: ["bb"],
  order: 75,
  preferOver: ["imessage"],
};

export const bluebubblesCapabilities: ChannelPlugin<ResolvedBlueBubblesAccount>["capabilities"] = {
  chatTypes: ["direct", "group"],
  media: true,
  reactions: true,
  edit: true,
  unsend: true,
  reply: true,
  effects: true,
  groupManagement: true,
};

export const bluebubblesReload = { configPrefixes: ["channels.bluebubbles"] };
export const bluebubblesConfigSchema = BlueBubblesChannelConfigSchema;

export const bluebubblesConfigAdapter =
  createScopedChannelConfigAdapter<ResolvedBlueBubblesAccount>({
    sectionKey: "bluebubbles",
    listAccountIds: listBlueBubblesAccountIds,
    resolveAccount: adaptScopedAccountAccessor(resolveBlueBubblesAccount),
    defaultAccountId: resolveDefaultBlueBubblesAccountId,
    clearBaseFields: ["serverUrl", "password", "name", "webhookPath"],
    resolveAllowFrom: (account: ResolvedBlueBubblesAccount) => account.config.allowFrom,
    formatAllowFrom: (allowFrom) =>
      formatNormalizedAllowFromEntries({
        allowFrom,
        normalizeEntry: (entry) => normalizeBlueBubblesHandle(entry.replace(/^bluebubbles:/i, "")),
      }),
  });

export function describeBlueBubblesAccount(account: ResolvedBlueBubblesAccount) {
  return describeWebhookAccountSnapshot({
    account,
    configured: account.configured,
    extra: {
      baseUrl: account.baseUrl,
    },
  });
}
