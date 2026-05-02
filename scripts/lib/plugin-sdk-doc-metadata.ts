export type PluginSdkDocCategory =
  | "channel"
  | "core"
  | "legacy"
  | "provider"
  | "runtime"
  | "utilities";

type PluginSdkDocMetadata = {
  category: PluginSdkDocCategory;
};

export const pluginSdkDocMetadata = {
  index: {
    category: "legacy",
  },
  "channel-runtime": {
    category: "legacy",
  },
  core: {
    category: "core",
  },
  "approval-runtime": {
    category: "runtime",
  },
  "approval-auth-runtime": {
    category: "runtime",
  },
  "approval-client-runtime": {
    category: "runtime",
  },
  "approval-delivery-runtime": {
    category: "runtime",
  },
  "approval-native-runtime": {
    category: "runtime",
  },
  "approval-reply-runtime": {
    category: "runtime",
  },
  "plugin-entry": {
    category: "core",
  },
  "plugin-test-api": {
    category: "utilities",
  },
  "plugin-test-contracts": {
    category: "utilities",
  },
  "plugin-test-runtime": {
    category: "utilities",
  },
  "channel-actions": {
    category: "channel",
  },
  "channel-config-schema": {
    category: "channel",
  },
  "channel-config-schema-legacy": {
    category: "channel",
  },
  "channel-contract": {
    category: "channel",
  },
  "channel-contract-testing": {
    category: "channel",
  },
  "channel-pairing": {
    category: "channel",
  },
  "channel-reply-pipeline": {
    category: "channel",
  },
  "channel-setup": {
    category: "channel",
  },
  "command-auth": {
    category: "channel",
  },
  zalouser: {
    category: "channel",
  },
  "command-status": {
    category: "channel",
  },
  "command-status-runtime": {
    category: "runtime",
  },
  "secret-input": {
    category: "channel",
  },
  "webhook-ingress": {
    category: "channel",
  },
  "provider-onboard": {
    category: "provider",
  },
  "provider-selection-runtime": {
    category: "provider",
  },
  "runtime-store": {
    category: "runtime",
  },
  "allow-from": {
    category: "utilities",
  },
  "reply-payload": {
    category: "utilities",
  },
  testing: {
    category: "utilities",
  },
  "channel-test-helpers": {
    category: "utilities",
  },
  "agent-runtime-test-contracts": {
    category: "utilities",
  },
  "channel-target-testing": {
    category: "utilities",
  },
  "provider-test-contracts": {
    category: "utilities",
  },
  "provider-http-test-mocks": {
    category: "utilities",
  },
  "test-env": {
    category: "utilities",
  },
  "test-fixtures": {
    category: "utilities",
  },
} as const satisfies Record<string, PluginSdkDocMetadata>;

export type PluginSdkDocEntrypoint = keyof typeof pluginSdkDocMetadata;

export function resolvePluginSdkDocImportSpecifier(entrypoint: PluginSdkDocEntrypoint): string {
  return entrypoint === "index" ? "openclaw/plugin-sdk" : `openclaw/plugin-sdk/${entrypoint}`;
}
