// Keep bundled setup entry imports narrow so setup loads do not pull the
// broader Twitch channel plugin surface.
export { twitchSetupPlugin } from "./src/setup-surface.js";
