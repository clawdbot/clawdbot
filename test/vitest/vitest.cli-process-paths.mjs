// CLI process tests launch real Node+tsx children and must not contend with the
// shared CLI module graph. Keep the owned list explicit so full and focused runs agree.
export const cliProcessTestFiles = [
  "src/cli/acp-cli-exit.process.test.ts",
  "src/cli/cli-process-child.test-helpers.test.ts",
  "src/cli/completion-cli.runner.process.test.ts",
  "src/cli/cron-output.process.test.ts",
  "src/cli/gateway-backed-exit-health.process.test.ts",
  "src/cli/gateway-backed-exit.process.test.ts",
  "src/cli/gateway-cli/shutdown-hard-exit.process.test.ts",
  "src/cli/help-exit.process.test.ts",
  "src/cli/message-plugin-cleanup.process.test.ts",
  "src/cli/hooks-cli.process.test.ts",
  "src/cli/plugins-authoring.process.test.ts",
  "src/cli/mcp-cli.import-boundary.test.ts",
  "src/cli/gateway-cli/run-loop.direct-stop-active-work.process.test.ts",
  "src/cli/update-dry-run-state.process.test.ts",
  "src/cli/doctor-output.process.test.ts",
  "src/cli/update-cli/update-command-lease.test.ts",
  "src/cli/one-shot-exit.test.ts",
  "src/cli/update-finalization-output.process.test.ts",
  "src/cli/cold-command-plugin-imports.process.test.ts",
  "src/cli/mcp-cli.probe-exit.process.test.ts",
  "src/cli/claws-authoring-state.process.test.ts",
  "src/cli/program/subcli-descriptors.test.ts",
  "src/cli/state-dir-gateway-check.process.test.ts",
  "src/cli/state-dir-gateway-check.server.test.ts",
];

const cliProcessTestFileSet = new Set(cliProcessTestFiles);

export function isCliProcessTestFile(value) {
  return cliProcessTestFileSet.has(value.replaceAll("\\", "/"));
}
