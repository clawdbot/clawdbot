// Packed Plugin Sdk Type Smoke script supports OpenClaw repository automation.
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
type PublicPluginSdkModules = [
  typeof import("openclaw/plugin-sdk/core"),
  typeof import("openclaw/plugin-sdk/channel-entry-contract"),
  typeof import("openclaw/plugin-sdk/config-contracts"),
  typeof import("openclaw/plugin-sdk/plugin-entry"),
  typeof import("openclaw/plugin-sdk/runtime-env"),
];

const resolvedModules = null as unknown as PublicPluginSdkModules;
const routeOwnerResolver: NonNullable<
  ChannelMessagingAdapter["resolveConversationRouteOwner"]
> = () => ({ kind: "unavailable" });

void resolvedModules;
void routeOwnerResolver;
