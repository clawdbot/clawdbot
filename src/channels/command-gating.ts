/**
 * Shared text-control command authorization policy for channel runtimes.
 *
 * These helpers are re-exported through the plugin SDK so built-in and external
 * channels make the same access-groups decisions for native command text.
 */

/** One channel-specific authorization source for text control commands. */
export type CommandAuthorizer = {
  /** True when this channel/user identity has an access-group rule configured. */
  configured: boolean;
  /** True when the configured rule permits the command. Ignored when unconfigured. */
  allowed: boolean;
};

/** Fallback policy for channels that have access groups globally disabled. */
export type CommandGatingModeWhenAccessGroupsOff = "allow" | "deny" | "configured";

/** Resolves whether any configured authorizer permits a control command. */
export function resolveCommandAuthorizedFromAuthorizers(params: {
  /** Global access-group switch for the channel/runtime. */
  useAccessGroups: boolean;
  /** Independent authorization sources, such as sender id and actor id. */
  authorizers: CommandAuthorizer[];
  /** Policy used only when `useAccessGroups` is false. Defaults to open. */
  modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): boolean {
  const { useAccessGroups, authorizers } = params;
  const mode = params.modeWhenAccessGroupsOff ?? "allow";
  if (!useAccessGroups) {
    if (mode === "allow") {
      return true;
    }
    if (mode === "deny") {
      return false;
    }
    // `configured` preserves the old open-by-default behavior until a channel has at least one
    // command authorizer configured, then enforces that configured source.
    const anyConfigured = authorizers.some((entry) => entry.configured);
    if (!anyConfigured) {
      return true;
    }
    return authorizers.some((entry) => entry.configured && entry.allowed);
  }
  return authorizers.some((entry) => entry.configured && entry.allowed);
}

/** Resolves command authorization and whether the current text command should be blocked. */
export function resolveControlCommandGate(params: {
  /** Global access-group switch for the channel/runtime. */
  useAccessGroups: boolean;
  /** Authorization sources checked by this channel command. */
  authorizers: CommandAuthorizer[];
  /** Channel setting that enables text commands as an input surface. */
  allowTextCommands: boolean;
  /** True when the current inbound message parsed as a control command. */
  hasControlCommand: boolean;
  /** Policy used only when `useAccessGroups` is false. Defaults to open. */
  modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): { commandAuthorized: boolean; shouldBlock: boolean } {
  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: params.useAccessGroups,
    authorizers: params.authorizers,
    modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
  });
  const shouldBlock = params.allowTextCommands && params.hasControlCommand && !commandAuthorized;
  return { commandAuthorized, shouldBlock };
}

/** Convenience gate for channels that check primary and secondary text command identities. */
export function resolveDualTextControlCommandGate(params: {
  /** Global access-group switch for the channel/runtime. */
  useAccessGroups: boolean;
  /** Whether the primary identity has an access-group rule. */
  primaryConfigured: boolean;
  /** Whether the primary configured rule permits the command. */
  primaryAllowed: boolean;
  /** Whether the secondary identity has an access-group rule. */
  secondaryConfigured: boolean;
  /** Whether the secondary configured rule permits the command. */
  secondaryAllowed: boolean;
  /** True when the current inbound message parsed as a control command. */
  hasControlCommand: boolean;
  /** Policy used only when `useAccessGroups` is false. Defaults to open. */
  modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): { commandAuthorized: boolean; shouldBlock: boolean } {
  // Treat primary and secondary identities as independent authorization sources; channels use
  // this when a text command can come from either a sender id or a platform-specific actor id.
  return resolveControlCommandGate({
    useAccessGroups: params.useAccessGroups,
    authorizers: [
      { configured: params.primaryConfigured, allowed: params.primaryAllowed },
      { configured: params.secondaryConfigured, allowed: params.secondaryAllowed },
    ],
    allowTextCommands: true,
    hasControlCommand: params.hasControlCommand,
    modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
  });
}
