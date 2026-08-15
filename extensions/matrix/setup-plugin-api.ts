// Keep bundled setup entry imports narrow so setup loads do not pull the
// broader Matrix runtime plugin surface.
export { matrixSetupPlugin } from "./src/channel.setup.js";
