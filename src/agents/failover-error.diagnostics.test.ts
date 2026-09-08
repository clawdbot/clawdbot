import { describe, expect, it, vi } from "vitest";
import { diagnosticErrorFailureKind } from "../infra/diagnostic-error-metadata.js";
import { attachErrorDiagnostic, formatErrorMessageForDisplay } from "../infra/error-diagnostics.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  coerceToFailoverError,
  hasProviderRequestSizeCeiling,
  isTimeoutError,
} from "./failover-error.js";
import { isLikelyContextOverflowError } from "./failover/classify.js";

// Provider hooks do not classify these native process-exit fixtures.
vi.mock("../plugins/provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-hook-runtime.js")>();
  return {
    ...actual,
    resolveProviderHookPlugin: () => undefined,
    resolveProviderPluginsForHooks: () => [],
  };
});

describe("failover diagnostic isolation", () => {
  it.each([
    "Rate limit exceeded",
    "Authentication failed: invalid_api_key",
    "Request timed out; operation was aborted",
    "INVALID_ARGUMENT: input exceeds the maximum number of tokens",
    "413 Request too large on tokens per minute (TPM): Limit 8000, Requested 8098",
  ])("keeps supplemental process diagnostics out of failure policy: %s", (diagnostic) => {
    const native = Object.freeze(new Error("Claude Code process exited with code 1"));
    const error = attachErrorDiagnostic(native, diagnostic);

    expect(error).toBe(native);
    expect(formatErrorMessageForDisplay(error)).toContain(diagnostic);
    for (const candidate of [error, new Error("Plugin execution failed", { cause: error })]) {
      expect(coerceToFailoverError(candidate)).toBeNull();
      expect(isTimeoutError(candidate)).toBe(false);
      expect(diagnosticErrorFailureKind(candidate)).toBeUndefined();
      expect(hasProviderRequestSizeCeiling(candidate)).toBe(false);
      expect(isLikelyContextOverflowError(formatErrorMessage(candidate))).toBe(false);
      expect(formatErrorMessage(candidate)).not.toContain(diagnostic);
    }
    expect(
      hasProviderRequestSizeCeiling(new AggregateError([{ error }], "Plugin execution failed")),
    ).toBe(false);
  });
});
