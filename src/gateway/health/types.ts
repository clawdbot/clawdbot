// Shared summary types returned by gateway health and rendered by the CLI.
import type { Snapshot } from "../../../packages/gateway-protocol/src/schema/snapshot.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";

type ProtocolHealth = Snapshot["health"];
type ProtocolPlugin = NonNullable<ProtocolHealth["plugins"]>;
type UnavailablePlugin = NonNullable<ProtocolPlugin["unavailable"]>[number];

/** Health snapshot for one configured channel account. */
export type ChannelAccountHealthSummary = ChannelAccountSnapshot & {
  authAgeMs?: number | null;
  [key: string]: unknown;
};

/** Channel-level health summary with optional per-account details. */
export type ChannelHealthSummary = ChannelAccountHealthSummary & {
  accounts?: Record<string, ChannelAccountHealthSummary>;
};

export type AgentHealthSummary = NonNullable<ProtocolHealth["agents"]>[number];

export type PluginHealthErrorSummary = ProtocolPlugin["errors"][number];

/** Plugin registry health summary. */
export type PluginHealthSummary = Omit<ProtocolPlugin, "unavailable"> & {
  unavailable?: Array<
    Omit<UnavailablePlugin, "diagnostic"> & {
      diagnostic: Omit<UnavailablePlugin["diagnostic"], "reason"> & {
        reason: import("../../plugins/runtime-degraded-state.js").PluginVerificationFailureReason;
      };
    }
  >;
};

/** Full gateway health payload consumed by `openclaw health`. */
export type HealthSummary = ProtocolHealth & {
  ok: true;
  ts: number;
  durationMs: number;
  plugins?: PluginHealthSummary;
  channels: Record<string, ChannelHealthSummary>;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  heartbeatSeconds: number;
  agents: AgentHealthSummary[];
  sessions: NonNullable<ProtocolHealth["sessions"]>;
};
