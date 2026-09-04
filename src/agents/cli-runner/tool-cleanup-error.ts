import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessageForDisplay } from "../../infra/error-diagnostics.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { CliOutput } from "../cli-output-contracts.js";

// Host-only terminal facts survive duplicated runtime chunks without becoming
// enumerable error payload or a caller-forgeable provider/retry code.
const cleanupOutputs = resolveGlobalSingleton(
  Symbol.for("openclaw.cliToolCleanupOutputs"),
  () => new WeakMap<object, CliOutput>(),
);

export function createCliToolCleanupError(output: CliOutput, failures: unknown[]): Error {
  const error = new AggregateError(
    failures,
    "CLI tool cleanup failed. Tool actions may already have run; verify their effects before retrying.",
    { cause: failures[0] },
  );
  error.name = "CliToolCleanupError";
  cleanupOutputs.set(error, output);
  return error;
}

// Bound the entire terminal display, including nested causes and diagnostics;
// the original error graph remains untouched for internal ownership and logging.
export function formatCliToolCleanupError(error: unknown): string {
  return truncateUtf16Safe(
    redactSensitiveText(formatErrorMessageForDisplay(error), { mode: "tools" }),
    2_048,
  );
}

export type CliToolCleanupFailure = { error: unknown; output: CliOutput };

export function findCliToolCleanupFailure(error: unknown): CliToolCleanupFailure | undefined {
  for (const candidate of collectNestedErrorCandidates(error)) {
    if (candidate && typeof candidate === "object") {
      const output = cleanupOutputs.get(candidate);
      if (output) {
        return { error, output };
      }
    }
  }
  return undefined;
}
