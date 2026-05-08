import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import { resolveIMessageAccount } from "./accounts.js";
import { IMESSAGE_ACTION_NAMES, IMESSAGE_ACTIONS } from "./actions-contract.js";
import { getCachedIMessagePrivateApiStatus } from "./private-api-status.js";
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
  return { actions: Array.from(actions) };
}
