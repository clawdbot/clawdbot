import { bundledPluginRoot } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const splitChannelExtensionShardSpecs = [
  {
    id: "discord",
    kind: "extensionDiscord",
    config: "test/vitest/vitest.extension-discord.config.ts",
  },
  {
    id: "slack",
    kind: "extensionSlack",
    config: "test/vitest/vitest.extension-slack.config.ts",
  },
  {
    id: "signal",
    kind: "extensionSignal",
    config: "test/vitest/vitest.extension-signal.config.ts",
  },
  {
    id: "imessage",
    kind: "extensionImessage",
    config: "test/vitest/vitest.extension-imessage.config.ts",
  },
  {
    id: "line",
    kind: "extensionLine",
    config: "test/vitest/vitest.extension-line.config.ts",
  },
];

export const splitChannelExtensionTestRoots = splitChannelExtensionShardSpecs.map((spec) =>
  bundledPluginRoot(spec.id),
);

export function resolveSplitChannelExtensionShard(root) {
  const normalizedRoot = root.replaceAll("\\", "/");
  return splitChannelExtensionShardSpecs.find(
    (spec) => bundledPluginRoot(spec.id) === normalizedRoot,
  );
}

export function isSplitChannelExtensionRoot(root) {
  return Boolean(resolveSplitChannelExtensionShard(root));
}
