import type { OpenClawConfig } from "./types.openclaw.js";

export type PluginAutoEnableCandidate =
  | {
      pluginId: string;
      kind: "channel-configured";
      channelId: string;
    }
  | {
      pluginId: string;
      kind: "provider-auth-configured";
      providerId: string;
    }
  | {
      pluginId: string;
      kind: "provider-model-configured";
      modelRef: string;
    }
  | {
      pluginId: string;
      kind: "web-fetch-provider-selected";
      providerId: string;
    }
  | {
      pluginId: string;
      kind: "plugin-web-search-configured";
    }
  | {
      pluginId: string;
      kind: "plugin-web-fetch-configured";
    }
  | {
      pluginId: string;
      kind: "plugin-tool-configured";
    }
  | {
      pluginId: string;
      kind: "setup-auto-enable";
      reason: string;
    };

export type PluginAutoEnableResult = {
  config: OpenClawConfig;
  changes: string[];
  autoEnabledReasons: Record<string, string[]>;
};
