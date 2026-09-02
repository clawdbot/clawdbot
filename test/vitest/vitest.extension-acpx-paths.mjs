// Test routing roots for the ACP extension suite.
export const acpxExtensionTestRoots = ["extensions/acpx"];

export function isAcpxExtensionRoot(root) {
  return acpxExtensionTestRoots.includes(root);
}
