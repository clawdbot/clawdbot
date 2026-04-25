export type DiscordMonitorStatusPatch = {
  connected?: boolean;
  lastEventAt?: number | null;
  lastTransportActivityAt?: number | null;
  lastConnectedAt?: number | null;
  lastDisconnect?:
    | string
    | {
        at: number;
        status?: number;
        error?: string;
        loggedOut?: boolean;
      }
    | null;
  lastInboundAt?: number | null;
  lastError?: string | null;
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
};

export type DiscordMonitorStatusSink = (patch: DiscordMonitorStatusPatch) => void;
