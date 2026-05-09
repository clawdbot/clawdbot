import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage, formatUncaughtError } from "../infra/errors.js";
import { formatCliCommand } from "./command-format.js";

type FormatCliFailureOptions = {
  title: string;
  error: unknown;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  includeDoctorHint?: boolean;
};

function hasDebugArg(argv: string[] | undefined): boolean {
  return Boolean(argv?.some((arg) => arg === "--debug" || arg === "--verbose"));
}

function shouldShowStack(argv: string[] | undefined, env: NodeJS.ProcessEnv): boolean {
  return hasDebugArg(argv) || isTruthyEnvValue(env.OPENCLAW_DEBUG);
}

function pushPrefixed(out: string[], value: string): void {
  for (const line of value.split("\n")) {
    if (line.trim().length > 0) {
      out.push(`[openclaw] ${line}`);
    }
  }
}

export function formatCliFailureLines(options: FormatCliFailureOptions): string[] {
  const env = options.env ?? process.env;
  const lines = [
    `[openclaw] ${options.title}`,
    `[openclaw] Reason: ${formatErrorMessage(options.error)}`,
  ];

  if (shouldShowStack(options.argv, env)) {
    lines.push("[openclaw] Stack:");
    pushPrefixed(lines, formatUncaughtError(options.error));
  } else {
    lines.push("[openclaw] Debug: set OPENCLAW_DEBUG=1 to include the stack trace.");
  }

  if (options.includeDoctorHint !== false) {
    lines.push(`[openclaw] Try: ${formatCliCommand("openclaw doctor", env)}`);
  }
  lines.push(`[openclaw] Help: ${formatCliCommand("openclaw --help", env)}`);
  return lines;
}
