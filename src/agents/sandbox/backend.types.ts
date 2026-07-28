/**
 * Shared sandbox backend registration contracts.
 *
 * Runtime creation and lifecycle cleanup stay behind this backend boundary.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import type { SandboxRegistryEntry } from "./registry.js";
import type { SandboxConfig } from "./types.js";

/** Current runtime state reported by a sandbox backend manager. */
export type SandboxBackendRuntimeInfo = {
  running: boolean;
  actualConfigLabel?: string;
  configLabelMatch: boolean;
};

/** Optional lifecycle manager for an existing registered sandbox runtime. */
export type SandboxBackendManager = {
  describeRuntime(params: {
    entry: SandboxRegistryEntry;
    config: OpenClawConfig;
    agentId?: string;
  }): Promise<SandboxBackendRuntimeInfo>;
  removeRuntime(params: {
    entry: SandboxRegistryEntry;
    config: OpenClawConfig;
    agentId?: string;
  }): Promise<void>;
};

/** Inputs needed to create a sandbox backend handle for one session scope. */
export type CreateSandboxBackendParams = {
  sessionKey: string;
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  cfg: SandboxConfig;
  requireCurrentConfig?: boolean;
};

/** Factory that creates a backend handle for a sandbox session. */
export type SandboxBackendFactory = (
  params: CreateSandboxBackendParams,
) => Promise<SandboxBackendHandle>;

/** Resolve the runtime workdir without creating or starting the backend. */
export type SandboxBackendWorkdirResolver = (params: CreateSandboxBackendParams) => string;

/** Registry input accepted for sandbox backend registration. */
export type SandboxBackendRegistration =
  | SandboxBackendFactory
  | {
      factory: SandboxBackendFactory;
      manager?: SandboxBackendManager;
      resolveWorkdir?: SandboxBackendWorkdirResolver;
    };

/** Normalized backend registration stored in the sandbox backend registry. */
export type RegisteredSandboxBackend = {
  factory: SandboxBackendFactory;
  manager?: SandboxBackendManager;
  resolveWorkdir?: SandboxBackendWorkdirResolver;
};

export type { SandboxBackendHandle, SandboxBackendId } from "./backend-handle.types.js";
export type { SandboxBackendWorkdirValidation } from "./backend-handle.types.js";
