import { discordProviderRuntime } from "./provider-runtime.js";

const defaultDiscordProviderRuntime = { ...discordProviderRuntime };

export const discordProviderTestSupport = {
  reset(): void {
    Object.assign(discordProviderRuntime, defaultDiscordProviderRuntime);
  },
  setFetchDiscordApplicationId(mock: typeof discordProviderRuntime.fetchDiscordApplicationId) {
    discordProviderRuntime.fetchDiscordApplicationId = mock;
  },
  setCreateDiscordNativeCommand(mock: typeof discordProviderRuntime.createDiscordNativeCommand) {
    discordProviderRuntime.createDiscordNativeCommand = mock;
  },
  setRunDiscordGatewayLifecycle(mock: typeof discordProviderRuntime.runDiscordGatewayLifecycle) {
    discordProviderRuntime.runDiscordGatewayLifecycle = mock;
  },
  setLoadDiscordVoiceRuntime(mock: typeof discordProviderRuntime.loadDiscordVoiceRuntime) {
    discordProviderRuntime.loadDiscordVoiceRuntime = mock;
  },
  setLoadDiscordProviderSessionRuntime(
    mock: typeof discordProviderRuntime.loadDiscordProviderSessionRuntime,
  ) {
    discordProviderRuntime.loadDiscordProviderSessionRuntime = mock;
  },
  setCreateClient(mock: typeof discordProviderRuntime.createClient) {
    discordProviderRuntime.createClient = mock;
  },
  setGetPluginCommandSpecs(mock: typeof discordProviderRuntime.getPluginCommandSpecs) {
    discordProviderRuntime.getPluginCommandSpecs = mock;
  },
  setResolveDiscordAccount(mock: typeof discordProviderRuntime.resolveDiscordAccount) {
    discordProviderRuntime.resolveDiscordAccount = mock;
  },
  setResolveNativeCommandsEnabled(
    mock: typeof discordProviderRuntime.resolveNativeCommandsEnabled,
  ) {
    discordProviderRuntime.resolveNativeCommandsEnabled = mock;
  },
  setResolveNativeSkillsEnabled(mock: typeof discordProviderRuntime.resolveNativeSkillsEnabled) {
    discordProviderRuntime.resolveNativeSkillsEnabled = mock;
  },
  setListNativeCommandSpecsForConfig(
    mock: typeof discordProviderRuntime.listNativeCommandSpecsForConfig,
  ) {
    discordProviderRuntime.listNativeCommandSpecsForConfig = mock;
  },
  setListSkillCommandsForAgents(mock: typeof discordProviderRuntime.listSkillCommandsForAgents) {
    discordProviderRuntime.listSkillCommandsForAgents = mock;
  },
  setIsVerbose(mock: typeof discordProviderRuntime.isVerbose) {
    discordProviderRuntime.isVerbose = mock;
  },
  setShouldLogVerbose(mock: typeof discordProviderRuntime.shouldLogVerbose) {
    discordProviderRuntime.shouldLogVerbose = mock;
  },
};
