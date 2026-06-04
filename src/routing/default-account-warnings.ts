// Shared warning text builders for channels that rely on implicit default
// accounts. Keep paths centralized so doctor/setup messages stay consistent.
function formatChannelDefaultAccountPath(channelKey: string): string {
  return `channels.${channelKey}.defaultAccount`;
}

export function formatChannelAccountsDefaultPath(channelKey: string): string {
  return `channels.${channelKey}.accounts.default`;
}

export function formatSetExplicitDefaultInstruction(channelKey: string): string {
  return `Set ${formatChannelDefaultAccountPath(channelKey)} or add ${formatChannelAccountsDefaultPath(channelKey)}`;
}

// Variant used when a channel already has configured accounts and should point
// the operator at one of them instead of suggesting a generic default.
export function formatSetExplicitDefaultToConfiguredInstruction(params: {
  channelKey: string;
}): string {
  return `Set ${formatChannelDefaultAccountPath(params.channelKey)} to one of these accounts, or add ${formatChannelAccountsDefaultPath(params.channelKey)}`;
}
