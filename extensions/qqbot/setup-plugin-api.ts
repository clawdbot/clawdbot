// Keep bundled setup entry imports narrow so setup loads do not pull the
// broader QQ Bot runtime plugin surface.
export { qqbotSetupPlugin } from "./src/channel.setup.js";
