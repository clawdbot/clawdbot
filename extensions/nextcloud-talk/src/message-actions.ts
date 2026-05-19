import {
  jsonResult,
  readStringParam,
  resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import { listNextcloudTalkAccountIds, resolveNextcloudTalkAccount } from "./accounts.js";
import { sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

const providerId = "nextcloud-talk";

function isAccountConfigured(account: {
  enabled: boolean;
  secret: string | null;
  baseUrl?: string | null;
}): boolean {
  return Boolean(account.enabled && account.secret?.trim() && account.baseUrl?.trim());
}

function hasConfiguredAccount(cfg: CoreConfig, accountId: string | null | undefined): boolean {
  if (accountId) {
    const account = resolveNextcloudTalkAccount({ cfg, accountId });
    return isAccountConfigured(account);
  }
  return listNextcloudTalkAccountIds(cfg)
    .map((id) => resolveNextcloudTalkAccount({ cfg, accountId: id }))
    .some(isAccountConfigured);
}

export const nextcloudTalkMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    if (!hasConfiguredAccount(cfg as CoreConfig, accountId)) {
      return null;
    }
    const actions: ChannelMessageActionName[] = ["send", "react"];
    return { actions };
  },

  supportsAction: ({ action }) => action !== "send",

  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    if (action === "send") {
      throw new Error("Send should be handled by outbound, not actions handler.");
    }

    if (action === "react") {
      const target = readStringParam(params, "to", {
        required: true,
        label: "to (room token)",
      });

      const messageIdRaw = resolveReactionMessageId({ args: params, toolContext });
      if (messageIdRaw == null) {
        throw new Error("messageId required");
      }
      const messageId = String(messageIdRaw);

      const emoji = readStringParam(params, "emoji", { required: true });

      // Reaction removal is part of the shared `react` tool contract but is not
      // yet wired through to a Nextcloud Talk DELETE sender. Reject explicitly
      // so callers do not get the opposite of what they requested.
      if (params.remove === true) {
        throw new Error(
          "Nextcloud Talk reaction removal is not supported yet; only adding reactions is implemented.",
        );
      }

      await sendReactionNextcloudTalk(target, messageId, emoji, {
        accountId: accountId ?? undefined,
        cfg: cfg as CoreConfig,
      });
      return jsonResult({ ok: true, added: emoji });
    }

    throw new Error(`Action ${action} not supported for ${providerId}.`);
  },
};
