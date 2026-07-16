// Tooling tests that need fresh module or process state instead of the shared serial worker.
export const toolingIsolatedTestFiles = [
  "test/plugins/bundled-provider-auth-literal-parity.test.ts",
  "test/scripts/check-extension-package-tsc-boundary.test.ts",
  "test/scripts/control-ui-i18n.test.ts",
  "test/scripts/openclaw-e2e-instance.test.ts",
];

const toolingIsolatedTestFileSet = new Set(toolingIsolatedTestFiles);

export function isToolingIsolatedTestFile(value) {
  return toolingIsolatedTestFileSet.has(value.replaceAll("\\", "/"));
}
