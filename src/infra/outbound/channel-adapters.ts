import { getChannelPlugin } from "../../channels/plugins/index.js";
import type {
  ChannelId,
  ChannelStructuredComponents,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type CrossContextComponentsBuilder = (message: string) => ChannelStructuredComponents;

export type CrossContextComponentsFactory = (params: {
  originLabel: string;
  message: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => ChannelStructuredComponents;

export type ChannelMessageAdapter = {
  supportsComponentsV2: boolean;
  buildCrossContextComponents?: CrossContextComponentsFactory;
};

const DEFAULT_ADAPTER: ChannelMessageAdapter = {
  supportsComponentsV2: false,
};

export function getChannelMessageAdapter(channel: ChannelId): ChannelMessageAdapter {
  const adapter = getChannelPlugin(channel)?.messaging?.buildCrossContextComponents;
  if (adapter) {
    return {
      supportsComponentsV2: true,
      buildCrossContextComponents: adapter,
    };
  }
  return DEFAULT_ADAPTER;
}
