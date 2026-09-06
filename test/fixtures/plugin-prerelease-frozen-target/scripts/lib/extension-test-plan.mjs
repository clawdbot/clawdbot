export const DEFAULT_EXTENSION_TEST_SHARD_COUNT = 2;

const plans = [
  {
    checkName: "checks-node-extensions-shard-1",
    extensionIds: ["alpha", "telegram"],
    index: 0,
    planGroups: [
      {
        config: "test/vitest/vitest.extension-telegram.config.mjs",
        extensionIds: ["telegram"],
        roots: ["extensions/telegram"],
      },
    ],
  },
  {
    checkName: "checks-node-extensions-shard-2",
    extensionIds: ["zeta"],
    index: 1,
    planGroups: [],
  },
];

export function createExtensionTestShards(params = {}) {
  if (!params.extensionIds) {
    return plans;
  }
  const selectedIds = new Set(params.extensionIds);
  return plans
    .map((plan) => ({
      ...plan,
      extensionIds: plan.extensionIds.filter((extensionId) => selectedIds.has(extensionId)),
    }))
    .filter((plan) => plan.extensionIds.length > 0);
}
