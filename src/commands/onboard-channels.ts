/** Re-export seam for channel onboarding flow helpers. */
export {
  createChannelOnboardingPostWriteHook,
  createChannelOnboardingPostWriteHookCollector,
  noteChannelStatus,
  runCollectedChannelOnboardingPostWriteHooks,
  setupChannels,
} from "../flows/channel-setup.js";
