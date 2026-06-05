// Test routing roots for Matrix extension tests.
import { bundledPluginRoot } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const matrixExtensionIds = ["matrix"];

export const matrixExtensionTestRoots = matrixExtensionIds.map((id) => bundledPluginRoot(id));

export function isMatrixExtensionRoot(root) {
  return matrixExtensionTestRoots.includes(root);
}
