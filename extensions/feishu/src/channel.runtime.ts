import {
  getChatInfo as getChatInfoImpl,
  getChatMembers as getChatMembersImpl,
  getFeishuMemberInfo as getFeishuMemberInfoImpl,
} from "./chat.js";
import {
  listFeishuDirectoryGroupsLive as listFeishuDirectoryGroupsLiveImpl,
  listFeishuDirectoryPeersLive as listFeishuDirectoryPeersLiveImpl,
} from "./directory.js";
import { feishuOutbound as feishuOutboundImpl } from "./outbound.js";
import {
  createPinFeishu as createPinFeishuImpl,
  listPinsFeishu as listPinsFeishuImpl,
  removePinFeishu as removePinFeishuImpl,
} from "./pins.js";
import { probeFeishu as probeFeishuImpl } from "./probe.js";
import {
  addReactionFeishu as addReactionFeishuImpl,
  listReactionsFeishu as listReactionsFeishuImpl,
  removeReactionFeishu as removeReactionFeishuImpl,
} from "./reactions.js";
import {
  editMessageFeishu as editMessageFeishuImpl,
  getMessageFeishu as getMessageFeishuImpl,
  sendCardFeishu as sendCardFeishuImpl,
  sendMessageFeishu as sendMessageFeishuImpl,
} from "./send.js";

export const feishuChannelRuntime = {
  listFeishuDirectoryGroupsLive: listFeishuDirectoryGroupsLiveImpl,
  listFeishuDirectoryPeersLive: listFeishuDirectoryPeersLiveImpl,
  feishuOutbound: { ...feishuOutboundImpl },
  createPinFeishu: createPinFeishuImpl,
  listPinsFeishu: listPinsFeishuImpl,
  removePinFeishu: removePinFeishuImpl,
  probeFeishu: probeFeishuImpl,
  addReactionFeishu: addReactionFeishuImpl,
  listReactionsFeishu: listReactionsFeishuImpl,
  removeReactionFeishu: removeReactionFeishuImpl,
  getChatInfo: getChatInfoImpl,
  getChatMembers: getChatMembersImpl,
  getFeishuMemberInfo: getFeishuMemberInfoImpl,
  editMessageFeishu: editMessageFeishuImpl,
  getMessageFeishu: getMessageFeishuImpl,
  sendCardFeishu: sendCardFeishuImpl,
  sendMessageFeishu: sendMessageFeishuImpl,
};
