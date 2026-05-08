import type { GatewayServiceRuntime } from "./service-runtime.js";

export type GatewayServiceEnv = Record<string, string | undefined>;

export type GatewayServiceInstallArgs = {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
  description?: string;
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
};

export type GatewayServiceRestartResult = { outcome: "completed" } | { outcome: "scheduled" };

export type GatewayServiceEnvArgs = {
  env?: GatewayServiceEnv;
};

export type GatewayServiceEnvironmentValueSource = "inline" | "file" | "inline-and-file";

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
  code: "missing-program" | "temporary-program" | "version-mismatch";
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
