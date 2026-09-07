// Keep bundled setup entry imports narrow so setup loads do not pull the
// broader Nostr runtime plugin surface.
export { nostrSetupPlugin } from "./src/channel.setup.js";
