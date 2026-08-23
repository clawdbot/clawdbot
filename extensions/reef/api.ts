export { reefPlugin } from "./src/channel.js";
export { reefMessageAdapter, reefOutboundAdapter } from "./src/outbound.js";
export { ReefTransportClient, ReefInboxConnection } from "./src/transport.js";
export type { WebSocketLike } from "./src/transport.js";
export { ReefFriendManager } from "./src/friends.js";
export { ReefMessageFlow, createConfiguredGuard } from "./src/flow.js";
export type {
  ReefKeys,
  ReefAccount,
  RelayFriend,
  InboxEntry,
  ReefDependencies,
  ReefIngressMessage,
} from "./src/types.js";
