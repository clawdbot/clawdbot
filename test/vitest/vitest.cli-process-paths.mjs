// CLI process tests launch real Node+tsx children and must not contend with the
// shared CLI module graph. Keep the owned list explicit so full and focused runs agree.
export const cliProcessTestFiles = [
  "src/cli/acp-cli-exit.process.test.ts",
  "src/cli/gateway-backed-exit.process.test.ts",
  "src/cli/gateway-cli/shutdown-hard-exit.process.test.ts",
  "src/cli/help-exit.process.test.ts",
  "src/cli/hooks-cli.process.test.ts",
  "src/cli/gateway-cli/run-loop.direct-stop-active-work.process.test.ts",
];

const cliProcessTestFileSet = new Set(cliProcessTestFiles);

export function isCliProcessTestFile(value) {
  return cliProcessTestFileSet.has(value.replaceAll("\\", "/"));
}
