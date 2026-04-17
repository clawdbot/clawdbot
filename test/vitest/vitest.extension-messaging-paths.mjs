import { bundledPluginRoot } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const messagingExtensionIds = [
  "googlechat",
  "nextcloud-talk",
  "nostr",
  "qqbot",
  "synology-chat",
  "tlon",
  "twitch",
];

export const messagingExtensionTestRoots = messagingExtensionIds.map((id) => bundledPluginRoot(id));

export function isMessagingExtensionRoot(root) {
  return messagingExtensionTestRoots.includes(root);
}
