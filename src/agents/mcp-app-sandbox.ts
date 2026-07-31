import {
  buildSandboxHostPath,
  normalizeSandboxHostCsp,
  resolveSandboxHostPort,
  type SandboxHostCsp,
} from "./sandbox-host.js";

export type McpAppCsp = SandboxHostCsp;

export const normalizeMcpAppCsp = normalizeSandboxHostCsp;
export const buildMcpAppSandboxPath = buildSandboxHostPath;
export const resolveMcpAppSandboxPort = resolveSandboxHostPort;
