/**
 * Bundled channel message-tool public artifact loader.
 *
 * Resolves lightweight discovery hooks without loading full channel plugins.
 */
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import type { ChannelMessageActionAdapter } from "./types.public.js";

/**
 * Narrow adapter surface used for message-tool schema discovery.
 */
export type ChannelMessageToolDiscoveryAdapter = Pick<
  ChannelMessageActionAdapter,
  "describeMessageTool"
>;

/**
 * Lightweight public artifact shape for bundled channel message-tool hooks.
 */
type MessageToolApi = {
  describeMessageTool?: ChannelMessageToolDiscoveryAdapter["describeMessageTool"];
};

const MESSAGE_TOOL_API_ARTIFACT_BASENAME = "message-tool-api.js";
const MISSING_PUBLIC_SURFACE_PREFIX = "Unable to resolve bundled plugin public surface ";

function loadBundledChannelMessageToolApi(channelId: string): MessageToolApi | undefined {
  const cacheKey = channelId.trim();
  try {
    return loadBundledPluginPublicArtifactModuleSync<MessageToolApi>({
      dirName: cacheKey,
      artifactBasename: MESSAGE_TOOL_API_ARTIFACT_BASENAME,
    });
  } catch (error) {
    // Missing artifacts are optional; present-but-broken artifacts should fail
    // so discovery does not silently hide invalid bundled plugin contracts.
    if (error instanceof Error && error.message.startsWith(MISSING_PUBLIC_SURFACE_PREFIX)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Resolves a bundled channel's message-tool discovery adapter without loading the full plugin.
 */
export function resolveBundledChannelMessageToolDiscoveryAdapter(
  channelId: string,
): ChannelMessageToolDiscoveryAdapter | undefined {
  const describeMessageTool = loadBundledChannelMessageToolApi(channelId)?.describeMessageTool;
  if (typeof describeMessageTool !== "function") {
    return undefined;
  }
  return { describeMessageTool };
}
