// Test routing roots for diffs extension tests.
export const diffsExtensionTestRoots = ["extensions/diffs"];

export function isDiffsExtensionRoot(root) {
  return diffsExtensionTestRoots.includes(root);
}
