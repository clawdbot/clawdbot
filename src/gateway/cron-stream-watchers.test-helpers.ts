import { vi } from "vitest";
import type { CronJob } from "../cron/types.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  SpawnInput,
} from "../process/supervisor/types.js";
import { createCronStreamWatchers } from "./cron-stream-watchers.js";

export function job(overrides: Partial<CronJob> = {}): CronJob {
  const base: CronJob = {
    id: "stream-job",
    name: "stream job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "stream", command: ["stream-source"], batchMs: 50 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "base" },
    state: { streamSourceIdentity: "source:stream-job" },
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    state: {
      streamSourceIdentity: `source:${merged.id}`,
      ...overrides.state,
    },
  };
}

export function exitResult(overrides: Partial<RunExit> = {}): RunExit {
  return {
    reason: "exit",
    exitCode: 0,
    exitSignal: null,
    durationMs: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
    ...overrides,
  };
}

export function fakeSupervisor() {
  const inputs: SpawnInput[] = [];
  const runs: ManagedRun[] = [];
  const exits: Array<(result: RunExit) => void> = [];
  const spawn = vi.fn(async (input: SpawnInput) => {
    inputs.push(input);
    let resolveWait!: (result: RunExit) => void;
    const wait = new Promise<RunExit>((resolve) => {
      resolveWait = resolve;
    });
    const run: ManagedRun = {
      runId: `run-${runs.length + 1}`,
      startedAtMs: Date.now(),
      stdin: undefined,
      cancel: vi.fn(() => resolveWait(exitResult({ reason: "manual-cancel" }))),
      detachOutput: vi.fn(),
      wait: () => wait,
    };
    runs.push(run);
    exits.push(resolveWait);
    return run;
  });
  const supervisor = {
    spawn,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  } satisfies ProcessSupervisor;
  return { inputs, runs, exits, spawn, supervisor };
}

export async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

export function createWatchers(
  params: Omit<Parameters<typeof createCronStreamWatchers>[0], "retireSource"> & {
    retireSource?: Parameters<typeof createCronStreamWatchers>[0]["retireSource"];
  },
) {
  return createCronStreamWatchers({
    retireSource: vi.fn(async (_jobId, _scheduleKey, identity) => `${identity}:retired`),
    ...params,
  });
}
