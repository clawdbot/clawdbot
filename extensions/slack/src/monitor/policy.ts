export function isSlackChannelAllowedByPolicy(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  channelAllowlistConfigured: boolean;
  channelAllowed: boolean;
}): boolean {
  if (params.groupPolicy === "disabled") {
    return false;
  }
  return (
    params.groupPolicy !== "allowlist" ||
    (params.channelAllowlistConfigured && params.channelAllowed)
  );
}
