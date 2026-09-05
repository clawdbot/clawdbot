import { info } from "../globals.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";

// Shared dry-run result contract for `openclaw config set` validation-only paths.
/** Config-set input mode that produced the simulated operation. */
export type ConfigSetDryRunInputMode = "value" | "json" | "builder" | "unset";

/** One validation error found during config-set dry-run processing. */
export type ConfigSetDryRunError = {
  kind: "missing-path" | "schema" | "resolvability" | "model" | "conflict";
  message: string;
  ref?: string;
};

/** Dry-run summary returned by config-set command handlers and tests. */
export type ConfigSetDryRunResult = {
  ok: boolean;
  operations: number;
  configPath: string;
  inputModes: ConfigSetDryRunInputMode[];
  checks: {
    schema: boolean;
    resolvability: boolean;
    resolvabilityComplete: boolean;
  };
  refsChecked: number;
  skippedExecRefs: number;
  errors?: ConfigSetDryRunError[];
};

export class ConfigSetDryRunValidationError extends Error {
  constructor(readonly result: ConfigSetDryRunResult) {
    super("config set dry-run validation failed");
    this.name = "ConfigSetDryRunValidationError";
  }
}

export function printConfigDryRunResult(
  result: ConfigSetDryRunResult,
  runtime: RuntimeEnv,
  json?: boolean,
): void {
  if (!result.ok) {
    if (json) {
      throw new ConfigSetDryRunValidationError(result);
    }
    throw new Error(
      formatDryRunFailureMessage({
        errors: result.errors ?? [],
        skippedExecRefs: result.skippedExecRefs,
      }),
    );
  }
  if (json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  if (!result.checks.schema && !result.checks.resolvability) {
    runtime.log(
      info(
        "Dry run note: value mode does not run schema/resolvability checks. Use --strict-json, builder flags, or batch mode to enable validation checks.",
      ),
    );
  }
  if (result.skippedExecRefs > 0) {
    runtime.log(info(formatSkippedExecRefs(result.skippedExecRefs)));
  }
  runtime.log(
    info(
      `Dry run successful: ${result.operations} update(s) validated against ${shortenHomePath(result.configPath)}.`,
    ),
  );
}

function formatSkippedExecRefs(count: number): string {
  return `Dry run note: skipped ${count} exec SecretRef resolvability check(s). Re-run with --allow-exec to execute exec providers during dry-run.`;
}

function formatDryRunFailureMessage(params: {
  errors: ConfigSetDryRunError[];
  skippedExecRefs: number;
}): string {
  const missingPathErrors = params.errors.filter((error) => error.kind === "missing-path");
  const schemaErrors = params.errors.filter((error) => error.kind === "schema");
  const resolveErrors = params.errors.filter((error) => error.kind === "resolvability");
  const modelErrors = params.errors.filter((error) => error.kind === "model");
  const lines: string[] = missingPathErrors.map((error) => error.message);
  if (schemaErrors.length > 0) {
    lines.push(
      "Dry run failed: config schema validation failed.",
      ...schemaErrors.map((error) => `- ${error.message}`),
    );
  }
  if (resolveErrors.length > 0) {
    lines.push(
      `Dry run failed: ${resolveErrors.length} SecretRef assignment(s) could not be resolved.`,
      ...resolveErrors
        .slice(0, 5)
        .map((error) => `- ${error.ref ?? "<unknown-ref>"} -> ${error.message}`),
    );
    if (resolveErrors.length > 5) {
      lines.push(`- ... ${resolveErrors.length - 5} more`);
    }
  }
  if (modelErrors.length > 0) {
    lines.push(
      "Dry run failed: model reference validation failed.",
      ...modelErrors.map((error) => `- ${error.message}`),
    );
  }
  if (params.skippedExecRefs > 0) {
    lines.push(formatSkippedExecRefs(params.skippedExecRefs));
  }
  return lines.join("\n");
}
