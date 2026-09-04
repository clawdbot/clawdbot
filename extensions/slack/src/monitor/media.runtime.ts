// Slack plugin module implements media behavior.
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

export const slackMediaLog = createSubsystemLogger("gateway/channels/slack").child("media");
export { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
export type { FetchLike } from "openclaw/plugin-sdk/media-runtime";
export { saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
