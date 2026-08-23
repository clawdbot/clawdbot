// Keep bundled setup entry imports narrow so setup loads do not pull the
// broader Teams channel plugin surface.
export { msteamsSetupPlugin } from "./src/channel.setup.js";
