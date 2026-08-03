// Imessage API module exposes the plugin public contract.
import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import { Type } from "typebox";
import { resolveIMessageAccount } from "./accounts.js";
import { IMESSAGE_ACTION_NAMES, IMESSAGE_ACTIONS } from "./actions-contract.js";
import {
  getCachedIMessagePrivateApiStatus,
  imessageRpcSupportsMethod,
} from "./private-api-status.js";
import { inferIMessageTargetChatType } from "./targets.js";

const PRIVATE_API_ACTIONS = new Set<ChannelMessageActionName>([
  "react",
  "edit",
  "unsend",
  "reply",
  "sendWithEffect",
  "renameGroup",
  "setGroupIcon",
  "addParticipant",
  "removeParticipant",
  "leaveGroup",
  "sendAttachment",
  "poll",
  "poll-vote",
]);

function isGroupTarget(raw?: string | null): boolean {
  if (!raw) {
    return false;
  }
  return inferIMessageTargetChatType(raw) === "group";
}

export function describeIMessageMessageTool({
  cfg,
  accountId,
  currentChannelId,
}: Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0]) {
  const account = resolveIMessageAccount({ cfg, accountId });
  if (!account.enabled || !account.configured) {
    return null;
  }
  const cliPath = account.config.cliPath?.trim() || "imsg";
  const privateApiStatus = getCachedIMessagePrivateApiStatus(cliPath);
  const gate = createActionGate(account.config.actions);
  const actions = new Set<ChannelMessageActionName>();
  for (const action of IMESSAGE_ACTION_NAMES) {
    const spec = IMESSAGE_ACTIONS[action];
    if (!spec?.gate || !gate(spec.gate)) {
      continue;
    }
    if (privateApiStatus?.available === false && PRIVATE_API_ACTIONS.has(action)) {
      continue;
    }
    if (
      action === "edit" &&
      privateApiStatus?.selectors &&
      !privateApiStatus.selectors.editMessage &&
      !privateApiStatus.selectors.editMessageItem
    ) {
      continue;
    }
    if (action === "unsend" && privateApiStatus?.selectors?.retractMessagePart !== true) {
      continue;
    }
    // Keep first-dispatch discovery optimistic while the status cache is empty;
    // handleAction probes lazily and enforces the exact selector before sending.
    if (
      action === "poll" &&
      privateApiStatus?.selectors &&
      !privateApiStatus.selectors.pollPayloadMessage
    ) {
      continue;
    }
    if (
      action === "poll-vote" &&
      privateApiStatus?.selectors &&
      !privateApiStatus.selectors.pollVoteMessage
    ) {
      continue;
    }
    // The injected helper can outlive the selected imsg binary. Require both
    // the native initializer and a binary new enough to advertise poll.vote.
    if (
      action === "poll-vote" &&
      privateApiStatus &&
      !imessageRpcSupportsMethod(privateApiStatus, "poll.vote")
    ) {
      continue;
    }
    actions.add(action);
  }
  if (!isGroupTarget(currentChannelId)) {
    for (const action of IMESSAGE_ACTION_NAMES) {
      if ("groupOnly" in IMESSAGE_ACTIONS[action] && IMESSAGE_ACTIONS[action].groupOnly) {
        actions.delete(action);
      }
    }
  }
  if (actions.delete("sendAttachment")) {
    actions.add("upload-file");
  }
  return {
    actions: Array.from(actions),
    ...(actions.has("poll-vote")
      ? {
          schema: {
            properties: {
              pollOptionText: Type.Optional(
                Type.String({ description: "Exact iMessage poll option text." }),
              ),
            },
            actions: ["poll-vote" as const],
            visibility: "all-configured" as const,
          },
        }
      : {}),
  };
}
