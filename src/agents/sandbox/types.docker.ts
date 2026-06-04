import type { SandboxDockerSettings } from "../../config/types.sandbox.js";

/**
 * Normalized Docker sandbox config after defaults fill required runtime fields.
 */
type RequiredDockerConfigKeys =
  | "image"
  | "containerPrefix"
  | "workdir"
  | "readOnlyRoot"
  | "tmpfs"
  | "network"
  | "capDrop";

export type SandboxDockerConfig = Omit<SandboxDockerSettings, RequiredDockerConfigKeys> &
  Required<Pick<SandboxDockerSettings, RequiredDockerConfigKeys>>;
