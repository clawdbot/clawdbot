// Test routing roots for Codex extension tests.
export const codexExtensionTestRoots = ["extensions/codex"];

export function isCodexExtensionRoot(root) {
  return codexExtensionTestRoots.includes(root);
}
