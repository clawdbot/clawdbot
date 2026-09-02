// Test routing roots for browser extension tests.
export const browserExtensionTestRoots = ["extensions/browser"];

export function isBrowserExtensionRoot(root) {
  return browserExtensionTestRoots.includes(root);
}
