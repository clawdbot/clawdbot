import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import type { SandboxRegistryEntry } from "./registry.js";
import type { SandboxConfig } from "./types.js";

export type SandboxBackendRuntimeInfo = {
  running: boolean;
  actualConfigLabel?: string;
  configLabelMatch: boolean;
};

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

export type CreateSandboxBackendParams = {
  sessionKey: string;
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
};

export type SandboxBackendFactory = (
  params: CreateSandboxBackendParams,
) => Promise<SandboxBackendHandle>;

export type SandboxBackendRegistration =
  | SandboxBackendFactory
  | {
      factory: SandboxBackendFactory;
      manager?: SandboxBackendManager;
    };

export type RegisteredSandboxBackend = {
  factory: SandboxBackendFactory;
  manager?: SandboxBackendManager;
};

export type { SandboxBackendHandle, SandboxBackendId } from "./backend-handle.types.js";
export type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendExecSpec,
  SandboxFsBridgeContext,
} from "./backend-handle.types.js";
