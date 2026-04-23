export const browserExtensionTestRoots = ["extensions/browser"];

export function isBrowserExtensionRoot(root) {
  return browserExtensionTestRoots.includes(root);
}
