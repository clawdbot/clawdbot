export type PluginCompatStatus = "active" | "deprecated" | "removal-pending" | "removed";

export type PluginCompatOwner =
  | "agent-runtime"
  | "channel"
  | "config"
  | "core"
  | "plugin-execution"
  | "provider"
  | "sdk"
  | "setup";

export type PluginCompatRecord<Code extends string = string> = {
  code: Code;
  status: PluginCompatStatus;
  owner: PluginCompatOwner;
  introduced: string;
  deprecated?: string;
  warningStarts?: string;
  removeAfter?: string;
  replacement?: string;
  docsPath: string;
  surfaces: readonly string[];
  diagnostics: readonly string[];
  tests: readonly string[];
  releaseNote?: string;
};
