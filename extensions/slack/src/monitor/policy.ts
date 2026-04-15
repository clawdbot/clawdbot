import { evaluateGroupRouteAccessForPolicy } from "openclaw/plugin-sdk/group-access";

export function isSlackChannelAllowedByPolicy(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  channelAllowlistConfigured: boolean;
  channelAllowed: boolean;
}): boolean {
  return evaluateGroupRouteAccessForPolicy({
    groupPolicy: params.groupPolicy,
    routeAllowlistConfigured: params.channelAllowlistConfigured,
    routeMatched: params.channelAllowed,
  }).allowed;
}
