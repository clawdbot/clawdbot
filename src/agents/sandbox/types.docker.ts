/**
 * Normalized Docker sandbox config type.
 *
 * Defaults fill required runtime fields from user-facing Docker sandbox settings.
 */
import type { SandboxDockerSettings } from "../../config/types.sandbox.js";

type RequiredDockerConfigKeys =
  | "image"
  | "containerPrefix"
  | "workdir"
  | "readOnlyRoot"
  | "tmpfs"
  | "network"
  | "capDrop";

export type SandboxDockerConfig = Omit<SandboxDockerSettings, RequiredDockerConfigKeys | "env"> &
  Required<Pick<SandboxDockerSettings, RequiredDockerConfigKeys>> & {
    env?: Record<string, string>;
  };
