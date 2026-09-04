// Packed Plugin Sdk Type Smoke script supports OpenClaw repository automation.
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
type PublicPluginSdkModules = [
  typeof import("openclaw/plugin-sdk/core"),
  typeof import("openclaw/plugin-sdk/channel-entry-contract"),
  typeof import("openclaw/plugin-sdk/config-contracts"),
  typeof import("openclaw/plugin-sdk/plugin-entry"),
  typeof import("openclaw/plugin-sdk/runtime-env"),
  typeof import("openclaw/plugin-sdk/tool-plugin"),
];

const resolvedModules = null as unknown as PublicPluginSdkModules;
const routeOwnerResolver: NonNullable<
  ChannelMessagingAdapter["resolveConversationRouteOwner"]
> = () => ({ kind: "unavailable" });

void resolvedModules;
void routeOwnerResolver;
void defineToolPlugin;
