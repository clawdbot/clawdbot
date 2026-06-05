/**
 * Backend-neutral sandbox runtime handle contracts.
 *
 * Docker, SSH, and future sandbox providers implement these command, exec, and fs-bridge surfaces.
 */
import type { SandboxFsBridge } from "./fs-bridge.types.js";

/**
 * Backend-neutral sandbox runtime handles used by Docker, SSH, and future sandbox providers.
 */
export type SandboxBackendId = string;

/** Shell exec specification prepared by a sandbox backend for process launch. */
export type SandboxBackendExecSpec = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdinMode: "pipe-open" | "pipe-closed";
  finalizeToken?: unknown;
};

/** Parameters for backend-managed shell commands used by fs bridges and probes. */
export type SandboxBackendCommandParams = {
  script: string;
  args?: string[];
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
};

/** Buffered command result returned by sandbox backend shell helpers. */
export type SandboxBackendCommandResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

/** Runtime context passed to backend-provided filesystem bridge factories. */
export type SandboxFsBridgeContext = {
  workspaceDir: string;
  agentWorkspaceDir: string;
  workspaceAccess: "none" | "ro" | "rw";
  containerName: string;
  containerWorkdir: string;
  docker: {
    binds?: string[];
  };
  backend?: {
    runShellCommand(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
  };
};

/** Live sandbox backend handle for command execution, cleanup, and optional fs bridge creation. */
export type SandboxBackendHandle = {
  id: SandboxBackendId;
  runtimeId: string;
  runtimeLabel: string;
  workdir: string;
  env?: Record<string, string>;
  configLabel?: string;
  configLabelKind?: string;
  capabilities?: {
    browser?: boolean;
  };
  buildExecSpec(params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
    usePty: boolean;
  }): Promise<SandboxBackendExecSpec>;
  finalizeExec?: (params: {
    status: "completed" | "failed";
    exitCode: number | null;
    timedOut: boolean;
    token?: unknown;
  }) => Promise<void>;
  runShellCommand(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
  createFsBridge?: (params: { sandbox: SandboxFsBridgeContext }) => SandboxFsBridge;
};
