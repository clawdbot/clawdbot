import { getLaneGroup } from "./command-queue.capacity-groups.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  publishLaneConfiguration,
} from "./command-queue.js";
import { getQueueState } from "./command-queue.state.js";
import type { CommandLaneSnapshot, CommandQueueEnqueueOptions } from "./command-queue.types.js";
import { getGatewayRestartDrainSignal } from "./gateway-work-admission.js";
import { CommandLane } from "./lanes.js";

const BACKGROUND_WORK_GROUP = "background-work";
const BACKGROUND_WORK_MAX_CONCURRENT = 3;

/** Register a stable core/plugin owner key, never a session or run identifier.
 * Only leaf work belongs here: a coordinator holding capacity must not await
 * another background task, which could need the same occupied capacity. */
export function createBackgroundWorkOwner(params: { owner: string; maxConcurrent: number }) {
  const owner = params.owner.trim();
  if (!owner) {
    throw new Error("Background work requires a stable owner key");
  }
  if (
    !Number.isInteger(params.maxConcurrent) ||
    params.maxConcurrent < 1 ||
    params.maxConcurrent > BACKGROUND_WORK_MAX_CONCURRENT
  ) {
    throw new Error(
      `Background owner concurrency must be between 1 and ${BACKGROUND_WORK_MAX_CONCURRENT}`,
    );
  }
  const lane = `${CommandLane.Background}:${owner}`;
  const register = () => {
    if (getLaneGroup(lane)) {
      if (getCommandLaneSnapshot(lane).maxConcurrent !== params.maxConcurrent) {
        throw new Error(
          `Background owner ${owner} is already registered with different concurrency`,
        );
      }
    } else {
      const group = getQueueState().laneGroups.get(BACKGROUND_WORK_GROUP);
      publishLaneConfiguration({
        lanes: { [lane]: params.maxConcurrent },
        groups: {
          [BACKGROUND_WORK_GROUP]: {
            budget: BACKGROUND_WORK_MAX_CONCURRENT,
            members: [...(group?.members ?? []), lane],
          },
        },
      });
    }
    return lane;
  };
  return {
    get lane() {
      return register();
    },
    enqueue<T>(
      task: (signal: AbortSignal) => Promise<T>,
      options?: CommandQueueEnqueueOptions,
    ): Promise<T> {
      const restartSignal = getGatewayRestartDrainSignal();
      const signal = options?.abortSignal
        ? AbortSignal.any([restartSignal, options.abortSignal])
        : restartSignal;
      return enqueueCommandInLane(
        register(),
        () => {
          signal.throwIfAborted();
          return task(signal);
        },
        { ...options, priority: "background", abortSignal: signal },
      );
    },
  };
}

export function isBackgroundWorkLane(lane: string): boolean {
  return getLaneGroup(lane)?.group === BACKGROUND_WORK_GROUP;
}

export function getBackgroundWorkSnapshot(): CommandLaneSnapshot {
  const group = getQueueState().laneGroups.get(BACKGROUND_WORK_GROUP);
  const members = [...(group?.members ?? [])].map((lane) => getCommandLaneSnapshot(lane));
  const activeCount = members.reduce((sum, member) => sum + member.activeCount, 0);
  return {
    lane: CommandLane.Background,
    activeCount,
    queuedCount: members.reduce((sum, member) => sum + member.queuedCount, 0),
    maxConcurrent: BACKGROUND_WORK_MAX_CONCURRENT,
    draining: members.some((member) => member.draining),
    generation: Math.max(0, ...members.map((member) => member.generation)),
    blockedBy:
      activeCount >= BACKGROUND_WORK_MAX_CONCURRENT
        ? "group-budget"
        : members.some((member) => member.queuedCount > 0 && member.blockedBy === "lane")
          ? "lane"
          : null,
  };
}
