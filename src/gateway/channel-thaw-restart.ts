// Host-thaw channel restart over the public ChannelManager surface.
import type { ChannelId } from "../channels/plugins/index.js";
import type { ChannelManager } from "./server-channels.js";

type ThawRestartManager = Pick<
  ChannelManager,
  "getRuntimeSnapshot" | "isManuallyStopped" | "stopChannel" | "startChannel"
>;

export type ThawRestartTarget = { channelId: ChannelId; accountId: string };

export type ThawRestartSelection =
  | { kind: "new-thaw"; pendingTargets?: readonly ThawRestartTarget[] }
  | { kind: "deferred-retry"; targets: readonly ThawRestartTarget[] };

function snapshotRunningTargets(manager: ThawRestartManager): ThawRestartTarget[] {
  return Object.entries(manager.getRuntimeSnapshot().channelAccounts).flatMap(
    ([channelId, accounts]) =>
      Object.entries(accounts ?? {})
        .filter(([, status]) => status?.running === true)
        .map(([accountId]) => ({ channelId: channelId as ChannelId, accountId })),
  );
}

function dedupeTargets(targets: readonly ThawRestartTarget[]): ThawRestartTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.channelId}:${target.accountId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Restarts every running, non-manually-stopped channel account after a host
 * thaw. Dead sockets from a freeze otherwise wait for the slow health sweep.
 */
export async function restartRunningChannelAccounts(
  manager: ThawRestartManager,
  opts: { shouldContinue: () => boolean; onError: (message: string) => void },
  selection: ThawRestartSelection = { kind: "new-thaw" },
): Promise<ThawRestartTarget[]> {
  const targets =
    selection.kind === "new-thaw"
      ? dedupeTargets([...(selection.pendingTargets ?? []), ...snapshotRunningTargets(manager)])
      : [...selection.targets];
  const failedTargets: ThawRestartTarget[] = [];
  for (const [index, target] of targets.entries()) {
    const { channelId, accountId } = target;
    if (manager.isManuallyStopped(channelId, accountId)) {
      continue;
    }
    // A suspension can commit while an account stop is awaited; retain only
    // unfinished targets so successful siblings are not disrupted again.
    if (!opts.shouldContinue()) {
      return [...failedTargets, ...targets.slice(index)];
    }
    try {
      let current = manager.getRuntimeSnapshot().channelAccounts[channelId]?.[accountId];
      if (!current) {
        continue;
      }
      await manager.stopChannel(channelId, accountId, { manual: false });
      if (!opts.shouldContinue()) {
        return [...failedTargets, target, ...targets.slice(index + 1)];
      }
      current = manager.getRuntimeSnapshot().channelAccounts[channelId]?.[accountId];
      if (!current) {
        continue;
      }
      let startOutcomes = await manager.startChannel(channelId, accountId, {
        preserveManualStop: true,
      });
      let startOutcome = startOutcomes.get(accountId);
      let restarted = manager.getRuntimeSnapshot().channelAccounts[channelId]?.[accountId];
      if (startOutcome?.status === "retry" && restarted?.restartPending === true) {
        // A timed-out stop uses a two-call recovery contract: the first call
        // requests replacement and the second discards the stale task.
        startOutcomes = await manager.startChannel(channelId, accountId, {
          preserveManualStop: true,
        });
        startOutcome = startOutcomes.get(accountId);
        restarted = manager.getRuntimeSnapshot().channelAccounts[channelId]?.[accountId];
      }
      // The channel manager owns all failures after handoff through its restart
      // supervisor. Intentional configuration skips are complete; only a
      // transient owner conflict remains this thaw's retry.
      if (startOutcome?.status === "retry") {
        failedTargets.push(target);
        opts.onError(
          `[${channelId}:${accountId}] host-thaw restart failed: replacement was not handed off (${startOutcome.reason})${restarted?.lastError ? `: ${restarted.lastError}` : ""}`,
        );
      }
    } catch (error) {
      failedTargets.push(target);
      opts.onError(`[${channelId}:${accountId}] host-thaw restart failed: ${String(error)}`);
    }
    if (!opts.shouldContinue()) {
      return [...failedTargets, ...targets.slice(index + 1)];
    }
  }
  return failedTargets;
}
