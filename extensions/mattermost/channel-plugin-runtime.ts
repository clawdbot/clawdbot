// Private runtime-bearing plugin export for the bundled Mattermost entry.
// Keep the actual channel plugin value off the lighter channel-plugin-api seam
// so bootstrap can lazy-load it without tripping bundle init cycles.
export { mattermostPlugin } from "./src/channel.js";
