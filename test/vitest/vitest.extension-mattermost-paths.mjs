// Test routing roots for Mattermost extension tests.
import { bundledPluginRoot } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const mattermostExtensionIds = ["mattermost"];

export const mattermostExtensionTestRoots = mattermostExtensionIds.map((id) =>
  bundledPluginRoot(id),
);

export function isMattermostExtensionRoot(root) {
  return mattermostExtensionTestRoots.includes(root);
}
