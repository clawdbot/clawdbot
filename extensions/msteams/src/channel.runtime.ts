import {
  listMSTeamsDirectoryGroupsLive as listMSTeamsDirectoryGroupsLiveImpl,
  listMSTeamsDirectoryPeersLive as listMSTeamsDirectoryPeersLiveImpl,
} from "./directory-live.js";
import {
  addParticipantMSTeams as addParticipantMSTeamsImpl,
  removeParticipantMSTeams as removeParticipantMSTeamsImpl,
  renameGroupMSTeams as renameGroupMSTeamsImpl,
} from "./graph-group-management.js";
import { getMemberInfoMSTeams as getMemberInfoMSTeamsImpl } from "./graph-members.js";
import {
  getMessageMSTeams as getMessageMSTeamsImpl,
  listPinsMSTeams as listPinsMSTeamsImpl,
  listReactionsMSTeams as listReactionsMSTeamsImpl,
  pinMessageMSTeams as pinMessageMSTeamsImpl,
  reactMessageMSTeams as reactMessageMSTeamsImpl,
  searchMessagesMSTeams as searchMessagesMSTeamsImpl,
  unpinMessageMSTeams as unpinMessageMSTeamsImpl,
  unreactMessageMSTeams as unreactMessageMSTeamsImpl,
} from "./graph-messages.js";
import {
  listChannelsMSTeams as listChannelsMSTeamsImpl,
  getChannelInfoMSTeams as getChannelInfoMSTeamsImpl,
} from "./graph-teams.js";
import { msteamsOutbound as msteamsOutboundImpl } from "./outbound.js";
import { probeMSTeams as probeMSTeamsImpl } from "./probe.js";
import {
  deleteMessageMSTeams as deleteMessageMSTeamsImpl,
  editMessageMSTeams as editMessageMSTeamsImpl,
  sendAdaptiveCardMSTeams as sendAdaptiveCardMSTeamsImpl,
  sendMessageMSTeams as sendMessageMSTeamsImpl,
} from "./send.js";
export const msTeamsChannelRuntime = {
  addParticipantMSTeams: addParticipantMSTeamsImpl,
  deleteMessageMSTeams: deleteMessageMSTeamsImpl,
  editMessageMSTeams: editMessageMSTeamsImpl,
  getChannelInfoMSTeams: getChannelInfoMSTeamsImpl,
  getMemberInfoMSTeams: getMemberInfoMSTeamsImpl,
  getMessageMSTeams: getMessageMSTeamsImpl,
  listChannelsMSTeams: listChannelsMSTeamsImpl,
  listPinsMSTeams: listPinsMSTeamsImpl,
  listReactionsMSTeams: listReactionsMSTeamsImpl,
  pinMessageMSTeams: pinMessageMSTeamsImpl,
  reactMessageMSTeams: reactMessageMSTeamsImpl,
  removeParticipantMSTeams: removeParticipantMSTeamsImpl,
  renameGroupMSTeams: renameGroupMSTeamsImpl,
  searchMessagesMSTeams: searchMessagesMSTeamsImpl,
  unpinMessageMSTeams: unpinMessageMSTeamsImpl,
  unreactMessageMSTeams: unreactMessageMSTeamsImpl,
  listMSTeamsDirectoryGroupsLive: listMSTeamsDirectoryGroupsLiveImpl,
  listMSTeamsDirectoryPeersLive: listMSTeamsDirectoryPeersLiveImpl,
  msteamsOutbound: { ...msteamsOutboundImpl },
  probeMSTeams: probeMSTeamsImpl,
  sendAdaptiveCardMSTeams: sendAdaptiveCardMSTeamsImpl,
  sendMessageMSTeams: sendMessageMSTeamsImpl,
};
