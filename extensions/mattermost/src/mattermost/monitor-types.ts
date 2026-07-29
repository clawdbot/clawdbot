// Mattermost plugin module shares monitor-scoped runtime dependencies.
import type { getMattermostRuntime } from "../runtime.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostClient } from "./client.js";
import type { createMattermostMonitorResources } from "./monitor-resources.js";
import type {
  ChannelAccountSnapshot,
  createChannelPairingController,
  OpenClawConfig,
  RuntimeEnv,
} from "./runtime-api.js";

export type MattermostMonitorContext = {
  core: ReturnType<typeof getMattermostRuntime>;
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  account: ResolvedMattermostAccount;
  client: MattermostClient;
  pairing: ReturnType<typeof createChannelPairingController>;
  botUserId: string;
  botUsername?: string;
  groupPolicy: "allowlist" | "open" | "disabled";
  resources: ReturnType<typeof createMattermostMonitorResources>;
  logDebugMessage: (message: string) => void;
  logVerboseMessage: (message: string) => void;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};
