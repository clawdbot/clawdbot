// Formats OpenClaw CLI command snippets for chat-facing command responses.
import { resolveCurrentOpenClawCliInvocation } from "../../infra/openclaw-cli-invocation.js";

const TEST_RUNNER_ENV_PREFIXES = ["VITEST_", "OPENCLAW_VITEST_"];

function quoteShellArg(value: string): string {
  if (process.platform === "win32") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Reconstructs the current OpenClaw CLI invocation with extra args. */
export function buildCurrentOpenClawCliArgv(args: string[]): string[] {
  const invocation = resolveCurrentOpenClawCliInvocation(args);
  return [invocation.command, ...invocation.args];
}

/** Clears test-runner env inherited by harness-hosted gateways before spawning the CLI. */
export function buildCurrentOpenClawCliExecEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const overrides: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    if (key === "VITEST" || TEST_RUNNER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      overrides[key] = "";
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/** Builds a shell-quoted command string for rerunning the current OpenClaw CLI. */
export function buildCurrentOpenClawCliCommand(args: string[]): string {
  return buildCurrentOpenClawCliArgv(args).map(quoteShellArg).join(" ");
}
