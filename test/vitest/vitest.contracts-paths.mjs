// Loader-free contract ownership shared by Vitest configs and changed-test routing.
export const channelSurfaceContractPatterns = [
  "src/channels/plugins/contracts/channel-catalog.contract.test.ts",
  "src/channels/plugins/contracts/channel-import-guardrails.test.ts",
  "src/channels/plugins/contracts/group-policy.fallback.contract.test.ts",
  "src/channels/plugins/contracts/message-tool-artifact.contract.test.ts",
  "src/channels/plugins/contracts/outbound-payload.contract.test.ts",
  "src/channels/plugins/contracts/*-shard-a.contract.test.ts",
  "src/channels/plugins/contracts/*-shard-e.contract.test.ts",
];

export const channelConfigContractPatterns = [
  "src/channels/plugins/contracts/gateway-auth-artifact.contract.test.ts",
  "src/channels/plugins/contracts/plugins-core.authorize-config-write.policy.contract.test.ts",
  "src/channels/plugins/contracts/plugins-core.authorize-config-write.targets.contract.test.ts",
  "src/channels/plugins/contracts/plugins-core.catalog.entries.contract.test.ts",
  "src/channels/plugins/contracts/*-shard-b.contract.test.ts",
  "src/channels/plugins/contracts/*-shard-f.contract.test.ts",
];

export const channelRegistryContractPatterns = [
  "src/channels/plugins/contracts/plugin-shape.contract.test.ts",
  "src/channels/plugins/contracts/plugins-core.catalog.paths.contract.test.ts",
  "src/channels/plugins/contracts/plugins-core.loader.contract.test.ts",
  "src/channels/plugins/contracts/plugins-core.registry.contract.test.ts",
  "src/channels/plugins/contracts/*-shard-c.contract.test.ts",
  "src/channels/plugins/contracts/*-shard-g.contract.test.ts",
];

export const channelSessionContractPatterns = [
  "src/channels/plugins/contracts/plugins-core.resolve-config-writes.contract.test.ts",
  "src/channels/plugins/contracts/registry.contract.test.ts",
  "src/channels/plugins/contracts/session-binding.registry-backed.contract.test.ts",
  "src/channels/plugins/contracts/session-key-artifact.contract.test.ts",
  "src/channels/plugins/contracts/thread-binding-artifact.contract.test.ts",
  "src/channels/plugins/contracts/*-shard-d.contract.test.ts",
  "src/channels/plugins/contracts/*-shard-h.contract.test.ts",
];

export const pluginContractPatterns = ["src/plugins/contracts/**/*.test.ts"];
