export const activeMemoryExtensionTestRoots = ["extensions/active-memory"];

export function isActiveMemoryExtensionRoot(root) {
  return activeMemoryExtensionTestRoots.includes(root);
}
