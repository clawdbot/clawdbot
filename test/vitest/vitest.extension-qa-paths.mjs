// Test routing roots for QA channel/lab extension tests.
export const qaExtensionTestRoots = ["extensions/qa-channel", "extensions/qa-lab"];

export function isQaExtensionRoot(root) {
  return qaExtensionTestRoots.includes(root);
}
