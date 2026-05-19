export function formatWhatsAppInboundListeningLog(account: {
  groups?: Record<string, unknown>;
  groupPolicy: "open" | "allowlist" | "disabled";
  hasGroupAllowFrom: boolean;
}): string {
  if (account.groupPolicy === "disabled") {
    return "Listening for WhatsApp inbound messages (DM + groups disabled by groupPolicy).";
  }
  if (account.groupPolicy === "allowlist" && !account.hasGroupAllowFrom) {
    return "Listening for WhatsApp inbound messages (DM + group inbound blocked by empty groupPolicy allowlist).";
  }

  const groups = account.groups ?? {};
  if (Object.keys(groups).length === 0) {
    const suffix =
      account.groupPolicy === "allowlist"
        ? "sender allowlist configured"
        : "no group allowlist configured";
    return `Listening for WhatsApp inbound messages (DM + all groups; ${suffix}).`;
  }
  if (Object.hasOwn(groups, "*")) {
    return "Listening for WhatsApp inbound messages (DM + all groups; wildcard configured).";
  }

  const explicitGroupCount = Object.keys(groups).length;
  const groupLabel = explicitGroupCount === 1 ? "group" : "groups";
  return `Listening for WhatsApp inbound messages (DM + ${explicitGroupCount} configured ${groupLabel}).`;
}
