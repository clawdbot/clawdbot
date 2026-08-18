// Shared root CLI failure formatting with debug stack gating and recovery hints.
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

type CliFailureDebugOptions = Pick<FormatCliFailureOptions, "argv" | "env">;

export type CliJsonFailure = {
  ok: false;
  error: {
    type: "cli_error";
    message: string;
  };
};

export class CliParseError extends Error {
  readonly humanOutput: string;
  readonly humanOutputWritten: boolean;
  readonly machineOutput: string;

  constructor(params: {
    message: string;
    humanOutput: string;
    humanOutputWritten?: boolean;
    machineOutput: string;
  }) {
    super(params.message);
    this.name = "CliParseError";
    this.humanOutput = params.humanOutput;
    this.humanOutputWritten = params.humanOutputWritten ?? false;
    this.machineOutput = params.machineOutput;
  }
}

/** Canonical machine-readable failure envelope for CLI-owned errors. */
export function formatCliJsonFailure(
  error: unknown,
  options: CliFailureDebugOptions = {},
): CliJsonFailure {
  const message =
    error instanceof CliParseError
      ? formatErrorMessage(error.machineOutput.trimEnd())
      : formatCliOperatorError(error, options);
  return {
    ok: false,
    error: {
      type: "cli_error",
      message,
    },
  };
}

function hasDebugArg(argv: string[] | undefined): boolean {
  for (const arg of argv ?? []) {
    // Arguments after the terminator belong to the child, not root stack-trace policy.
    if (arg === "--") {
      return false;
    }
    if (arg === "--debug" || arg === "--verbose") {
      return true;
    }
  }
  return false;
}

function shouldShowDebugDetails(
  argv: string[] | undefined = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return hasDebugArg(argv) || isTruthyEnvValue(env.OPENCLAW_DEBUG);
}

export function formatCliOperatorError(
  error: unknown,
  options: CliFailureDebugOptions = {},
): string {
  const includeCause = shouldShowDebugDetails(options.argv, options.env);
  const value =
    !includeCause && error instanceof Error ? error.message || error.name || "Error" : error;
  return formatErrorMessage(value);
}

function pushPrefixed(out: string[], value: string): void {
  for (const line of value.split("\n")) {
    if (line.trim().length > 0) {
      out.push(`[openclaw] ${line}`);
    }
  }
}

export function formatCliFailureLines(options: FormatCliFailureOptions): string[] {
  if (options.error instanceof CliParseError) {
    return options.error.humanOutputWritten ? [] : options.error.humanOutput.trimEnd().split("\n");
  }

  // Default output stays terse; causes and stack traces require explicit debug intent.
  const env = options.env ?? process.env;
  const showDebugDetails = shouldShowDebugDetails(options.argv, env);
  const lines = [
    `[openclaw] ${options.title}`,
    `[openclaw] Reason: ${formatCliOperatorError(options.error, {
      argv: options.argv,
      env,
    })}`,
  ];

  if (showDebugDetails) {
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
