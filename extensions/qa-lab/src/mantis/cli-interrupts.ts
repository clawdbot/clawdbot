import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { MANTIS_WORKTREE_CLEANUP_TIMEOUT_MS } from "./run-command.constants.js";
import { findMantisFailureArtifactPath } from "./run-failure.runtime.js";

type MantisCliInterrupt = "SIGINT" | "SIGTERM";

const INTERRUPT_EXIT_CODES: Record<MantisCliInterrupt, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

const MANTIS_INTERRUPT_REPORTING_GRACE_MS = 5_000;
const RUN_NODE_SHUTDOWN_GRACE_MESSAGE_TYPE = "openclaw:shutdown-grace";

class MantisCliInterruptError extends Error {
  constructor(signal: MantisCliInterrupt) {
    super(`Mantis interrupted by ${signal}`);
    this.name = "MantisCliInterruptError";
  }
}

function requestMantisShutdownGrace(): void {
  if (typeof process.send !== "function") {
    return;
  }
  try {
    // scripts/run-node.mts owns the matching bounded launcher contract. The
    // extra reporting grace lets error.txt and stderr settle after cleanup.
    process.send({
      graceMs: MANTIS_WORKTREE_CLEANUP_TIMEOUT_MS + MANTIS_INTERRUPT_REPORTING_GRACE_MS,
      type: RUN_NODE_SHUTDOWN_GRACE_MESSAGE_TYPE,
    });
  } catch {
    // Direct CLI entrypoints have no IPC parent; Mantis still owns its cleanup.
  }
}

function isExpectedMantisInterrupt(
  error: unknown,
  interruptReason: MantisCliInterruptError,
  seen = new Set<unknown>(),
): boolean {
  if (error === interruptReason) {
    return true;
  }
  if (!error || (typeof error !== "object" && typeof error !== "function") || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (error instanceof AggregateError) {
    if (error.errors.length === 0) {
      return false;
    }
    const errorsExpected = error.errors.every((entry) =>
      isExpectedMantisInterrupt(entry, interruptReason, seen),
    );
    const causeExpected =
      error.cause === undefined ||
      error.errors.includes(error.cause) ||
      isExpectedMantisInterrupt(error.cause, interruptReason, seen);
    return errorsExpected && causeExpected;
  }
  if ("cause" in error && error.cause !== undefined) {
    return isExpectedMantisInterrupt(error.cause, interruptReason, seen);
  }
  return false;
}

function formatUnexpectedMantisInterruptError(
  error: unknown,
  interruptReason: MantisCliInterruptError,
): string {
  const lines = [formatErrorMessage(error)];
  if (error instanceof AggregateError) {
    for (const [index, nestedError] of error.errors.entries()) {
      if (!isExpectedMantisInterrupt(nestedError, interruptReason)) {
        lines.push(`${index + 1}. ${formatErrorMessage(nestedError)}`);
      }
    }
  }
  return lines.join("\n");
}

export async function runWithMantisCliInterrupts(
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const abortController = new AbortController();
  let interruptedBy: MantisCliInterrupt | undefined;
  let interruptReason: MantisCliInterruptError | undefined;
  requestMantisShutdownGrace();
  const interrupt = (signal: MantisCliInterrupt) => {
    if (interruptedBy) {
      return;
    }
    interruptedBy = signal;
    interruptReason = new MantisCliInterruptError(signal);
    abortController.abort(interruptReason);
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");

  // Mantis commands own detached POSIX process groups, so retain repeated
  // signal ownership until AbortSignal cleanup finishes.
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    await run(abortController.signal);
  } catch (error) {
    if (!interruptedBy) {
      throw error;
    }
    if (interruptReason && isExpectedMantisInterrupt(error, interruptReason)) {
      const errorPath = findMantisFailureArtifactPath(error);
      if (errorPath) {
        process.stderr.write(`Mantis ${interruptedBy} error details: ${errorPath}\n`);
      }
    } else {
      process.stderr.write(
        `Mantis ${interruptedBy} cleanup failed:\n${formatUnexpectedMantisInterruptError(error, interruptReason ?? new MantisCliInterruptError(interruptedBy))}\n`,
      );
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (interruptedBy) {
      process.exitCode = INTERRUPT_EXIT_CODES[interruptedBy];
    }
  }
}
