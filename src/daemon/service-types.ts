/** Shared daemon service argument, state, and command config contracts. */
import type { GatewayServiceRuntime } from "./service-runtime.js";

/** Environment map passed to service renderers and platform supervisors. */
export type GatewayServiceEnv = Record<string, string | undefined>;

/** Arguments required to render/install a managed gateway service. */
export type GatewayServiceInstallArgs = {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  warn?: (message: string) => void;
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
  description?: string;
  // Verified before a config rewrite; Windows uses this to bridge a transient
  // listener gap while replacing a Startup-folder fallback.
  startupFallbackTakeoverRuntime?: GatewayServiceRuntime;
};

export type GatewayServiceStageArgs = GatewayServiceInstallArgs;

export type GatewayServiceManageArgs = {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
};

export type GatewayServiceControlArgs = {
  stdout: NodeJS.WritableStream;
  env?: GatewayServiceEnv;
  disable?: boolean;
  warn?: (message: string) => void;
};

export type GatewayServiceRestartResult = { outcome: "completed" } | { outcome: "scheduled" };

export type GatewayServiceEnvArgs = {
  env?: GatewayServiceEnv;
  // Bounds service-manager probes (e.g. `systemctl`) so a wedged daemon socket
  // cannot hang status reads indefinitely. Only status read paths set this;
  // control/install paths leave it unset to preserve their existing behavior.
  timeoutMs?: number;
};

/** Options for read-only service inspection that should fail soft under a deadline. */
export type GatewayServiceReadOptions = {
  timeoutMs?: number;
};

export type GatewayServiceEnvironmentValueSource = "inline" | "file" | "inline-and-file";

/** Parsed command and env metadata from an installed platform service. */
export type GatewayServiceCommandConfig = {
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
  sourcePath?: string;
};

export type GatewayServiceState = {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  env: GatewayServiceEnv;
  command: GatewayServiceCommandConfig | null;
  runtime?: GatewayServiceRuntime;
};

export type GatewayServiceStartRepairIssue = {
  code: "missing-program" | "port-mismatch" | "temporary-program" | "version-mismatch";
  message: string;
};

export type GatewayServiceStartResult =
  | { outcome: "started"; state: GatewayServiceState }
  | { outcome: "scheduled"; state: GatewayServiceState }
  | { outcome: "missing-install"; state: GatewayServiceState }
  | {
      outcome: "repair-required";
      state: GatewayServiceState;
      issues: GatewayServiceStartRepairIssue[];
    };

export type GatewayServiceRenderArgs = {
  description?: string;
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
  environmentFiles?: string[];
};
