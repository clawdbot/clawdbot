// Gateway channel runtime snapshot types.
// Exposes read-only channel/account state to status and server-method surfaces.
import type { ChannelId, ChannelAccountSnapshot } from "../channels/plugins/types.public.js";

/** Snapshot of channel runtime state keyed by channel and account id. */
export type ChannelRuntimeSnapshot = {
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};

/** The lifecycle owner's decision for one requested account start, separate from connectivity. */
export type ChannelAccountStartOutcome =
  | { status: "handed-off" }
  | { status: "retry"; reason: "stop-in-flight" | "task-owned" | "start-in-flight" }
  | {
      status: "skipped";
      reason:
        | "unsupported"
        | "autostart-suppressed"
        | "ambient-suppressed"
        | "disabled"
        | "unconfigured"
        | "secret-unavailable"
        | "unlinked"
        | "manual-stop";
    };

export type StartChannelOptions = {
  preserveRestartAttempts?: boolean;
  preserveManualStop?: boolean;
  /** Reload leaves snapshot-cold accounts stopped without bypassing credential-file reinspection. */
  skipUnavailableAccounts?: boolean;
  deferAccountStartUntil?: Promise<void>;
  manual?: boolean;
};
