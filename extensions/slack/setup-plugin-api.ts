// Keep bundled setup entry imports narrow so setup loads do not pull the
// broader Slack channel plugin surface.
export { slackSetupPlugin } from "./src/channel.setup.js";
