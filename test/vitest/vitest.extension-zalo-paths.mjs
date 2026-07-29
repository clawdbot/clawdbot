// Test routing roots for Zalo extension tests.
export const zaloExtensionTestRoots = ["extensions/zalo", "extensions/zalouser"];

export function isZaloExtensionRoot(root) {
  return zaloExtensionTestRoots.includes(root);
}
