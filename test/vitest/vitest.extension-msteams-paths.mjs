// Test routing roots for Microsoft Teams extension tests.
import { bundledPluginRoot } from "../../scripts/lib/bundled-plugin-paths.mjs";

const msTeamsExtensionIds = ["msteams"];

export const msTeamsExtensionTestRoots = msTeamsExtensionIds.map((id) => bundledPluginRoot(id));

export function isMsTeamsExtensionRoot(root) {
  return msTeamsExtensionTestRoots.includes(root);
}
