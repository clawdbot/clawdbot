export type ConfigSetDryRunInputMode = "value" | "json" | "builder" | "unset";

export type ConfigSetDryRunError = {
  kind: "missing-path" | "schema" | "resolvability";
  message: string;
  ref?: string;
};

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
