// Shared dry-run result contract for `openclaw config set` validation-only paths.
/** Config-set input mode that produced the simulated operation. */
export type ConfigSetDryRunInputMode = "value" | "json" | "builder" | "unset";

/** One validation error found during config-set dry-run processing. */
export type ConfigSetDryRunError = {
  kind: "missing-path" | "schema" | "resolvability";
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
