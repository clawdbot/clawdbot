// Test routing roots for memory extension suites.
export const memoryExtensionTestRoots = [
  "extensions/memory-core",
  "extensions/memory-lancedb",
  "extensions/memory-wiki",
];

export function isMemoryExtensionRoot(root) {
  return memoryExtensionTestRoots.includes(root);
}
