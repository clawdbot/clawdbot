// Host-thaw channel restart over the public ChannelManager surface.
import type { ChannelId } from "../channels/plugins/index.js";
import type { ChannelManager } from "./server-channels.js";

type ThawRestartManager = Pick<
  ChannelManager,
  "getRuntimeSnapshot" | "isManuallyStopped" | "stopChannel" | "startChannel"
>;

/**
 * Restarts every running, non-manually-stopped channel account after a host
 * thaw. Dead sockets from a freeze otherwise wait for the slow health sweep.
 */
export async function restartRunningChannelAccounts(
  manager: ThawRestartManager,
  opts: { shouldContinue: () => boolean; onError: (message: string) => void },
): Promise<void> {
  const snapshot = manager.getRuntimeSnapshot();
  for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
    for (const [accountId, status] of Object.entries(accounts ?? {})) {
      const channel = channelId as ChannelId;
      if (status?.running !== true || manager.isManuallyStopped(channel, accountId)) {
        continue;
      }
      // A suspension can commit while an account stop is awaited; later
      // accounts must stay untouched so the prepared gateway remains quiet.
      if (!opts.shouldContinue()) {
        return;
      }
      try {
        await manager.stopChannel(channel, accountId, { manual: false });
        if (!opts.shouldContinue()) {
          return;
        }
        await manager.startChannel(channel, accountId, { preserveManualStop: true });
        const restarted = manager.getRuntimeSnapshot().channelAccounts[channel]?.[accountId];
        if (restarted?.restartPending === true) {
          // A timed-out stop uses a two-call recovery contract: the first call
          // requests replacement and the second discards the stale task.
          await manager.startChannel(channel, accountId, { preserveManualStop: true });
        }
      } catch (error) {
        opts.onError(`[${channel}:${accountId}] host-thaw restart failed: ${String(error)}`);
      }
    }
  }
}
