/**
 * Bundled channel message-tool public artifact loader.
 *
 * Resolves lightweight discovery hooks without loading full channel plugins.
 */
import { loadOptionalBundledChannelPublicArtifact } from "./optional-public-artifact.js";
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

function loadBundledChannelMessageToolApi(channelId: string): MessageToolApi | undefined {
  return loadOptionalBundledChannelPublicArtifact({
    channelId,
    artifactBasename: "message-tool-api.js",
  });
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
