// Test routing roots for Feishu extension tests.
import { bundledPluginRoot } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const feishuExtensionIds = ["feishu"];

export const feishuExtensionTestRoots = feishuExtensionIds.map((id) => bundledPluginRoot(id));

export function isFeishuExtensionRoot(root) {
  return feishuExtensionTestRoots.includes(root);
}
