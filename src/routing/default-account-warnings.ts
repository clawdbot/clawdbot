function formatChannelDefaultAccountPath(channelKey: string): string {
  return `channels.${channelKey}.defaultAccount`;
}

export function formatChannelAccountsDefaultPath(channelKey: string): string {
  return `channels.${channelKey}.accounts.default`;
}

export function formatSetExplicitDefaultInstruction(channelKey: string): string {
  return `Set ${formatChannelDefaultAccountPath(channelKey)} or add ${formatChannelAccountsDefaultPath(channelKey)}`;
}

export function formatSetExplicitDefaultToConfiguredInstruction(params: {
  channelKey: string;
}): string {
  return `Set ${formatChannelDefaultAccountPath(params.channelKey)} to one of these accounts, or add ${formatChannelAccountsDefaultPath(params.channelKey)}`;
}
