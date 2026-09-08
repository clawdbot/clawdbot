import type { GatewayServiceEnv } from "./service-types.js";

type SystemdEnvironmentFileSpec = string | [string, boolean];

export type SystemdCommandSnapshotParams = {
  programArguments: string[];
  workingDirectory: string;
  inlineEnvironment: Record<string, string>;
  environmentFileSpecs: SystemdEnvironmentFileSpec[];
  unsetEnvironment: string[];
  env: GatewayServiceEnv;
  unitPath: string;
  failOnUnavailable?: boolean;
};

export type SystemdEnvironmentFilesParams = {
  environmentFileSpecs: SystemdEnvironmentFileSpec[];
  env: GatewayServiceEnv;
  unitPath: string;
  failOnUnavailable?: boolean;
};
