// Keep bundled setup entry imports narrow so setup loads do not pull the
// broader Google Chat runtime plugin surface.
export { googlechatSetupPlugin } from "./src/channel.setup.js";
