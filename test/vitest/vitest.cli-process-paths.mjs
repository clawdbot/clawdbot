// CLI process/lifecycle tests launch children or own global process state and must
// not contend with the shared CLI module graph. Keep full and focused runs aligned.
export const cliProcessTestFiles = [
  "src/cli/acp-cli-exit.process.test.ts",
  "src/cli/gateway-cli/run-loop.test.ts",
  "src/cli/gateway-backed-exit.process.test.ts",
  "src/cli/help-exit.process.test.ts",
  "src/cli/hooks-cli.process.test.ts",
];

const cliProcessTestFileSet = new Set(cliProcessTestFiles);

export function isCliProcessTestFile(value) {
  return cliProcessTestFileSet.has(value.replaceAll("\\", "/"));
}
