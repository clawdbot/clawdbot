// Keep bundled setup entry imports narrow so setup loads do not pull the
// broader QA channel runtime and gateway surface.
export { qaChannelSetupPlugin } from "./src/channel.setup.js";
