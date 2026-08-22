/** Re-export seam for channel onboarding flow helpers. */
export {
  createChannelOnboardingPostWriteHook,
  createChannelSetupTransaction,
  runCollectedChannelOnboardingPostWriteHooks,
  setupChannels,
} from "../flows/channel-setup.js";
export { noteChannelStatus } from "../flows/channel-setup.status.js";
