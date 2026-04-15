// Private runtime barrel for the bundled Nextcloud Talk extension.
// Keep this barrel thin and aligned with the local extension surface.

export * from "openclaw/plugin-sdk/nextcloud-talk";
export { setNextcloudTalkRuntime } from "./src/runtime.js";
