// Gateway cron lazy loader.
// Defers scheduler startup until cron is touched by runtime or API handlers.
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import type { GatewayCronState } from "./server-cron.js";

type LazyGatewayCronParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  env?: NodeJS.ProcessEnv;
};

type LoadedGatewayCronState = {
  state: GatewayCronState;
  phase: "idle" | "starting" | "started" | "stopped";
  startPromise: Promise<void> | null;
  startGeneration: number | null;
  schedulingPaused: boolean;
  underlyingStartInFlight: boolean;
  underlyingStarted: boolean;
};

/** Creates a cron state proxy that imports the real cron service on first use. */
export function createLazyGatewayCronState(params: LazyGatewayCronParams): GatewayCronState {
  const env = params.env ?? process.env;
  const storePath = resolveCronJobsStorePathFromConfig(params.cfg, env);
  const cronEnabled = env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;
  let loaded: LoadedGatewayCronState | null = null;
  let stopped = false;
  let lifecycleGeneration = 0;
  let schedulingPaused = false;
  const schedulingResumeWaiters = new Set<() => void>();
  const releaseSchedulingResumeWaiters = () => {
    const waiters = Array.from(schedulingResumeWaiters);
    schedulingResumeWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  };
  const waitForSchedulingResume = async () => {
    if (!schedulingPaused) {
      return;
    }
    await new Promise<void>((resolve) => {
      schedulingResumeWaiters.add(resolve);
    });
  };
  const cronStateLoader = createLazyPromiseLoader(
    () =>
      import("./server-cron.js").then(({ buildGatewayCronService }) => {
        loaded = {
          state: buildGatewayCronService(params),
          phase: "idle",
          startPromise: null,
          startGeneration: null,
          schedulingPaused: false,
          underlyingStartInFlight: false,
          underlyingStarted: false,
        };
        if (schedulingPaused) {
          loaded.state.cron.pauseScheduling();
          loaded.schedulingPaused = true;
        }
        return loaded;
      }),
    { cacheRejections: true },
  );

  const load = async (): Promise<LoadedGatewayCronState> => {
    if (loaded) {
      return loaded;
    }
    // Share the same import promise across concurrent API calls so only one
    // scheduler instance is built for a Gateway process.
    return await cronStateLoader.load();
  };

  const cron: GatewayCronServiceContract = {
    async start() {
      stopped = false;
      const generation = lifecycleGeneration;
      const startCancelled = () => stopped || generation !== lifecycleGeneration;
      const resolved = await load();
      const hasStarted = () => resolved.phase === "started";
      if (startCancelled()) {
        return;
      }
      if (hasStarted()) {
        return;
      }
      if (resolved.startPromise) {
        const pendingGeneration = resolved.startGeneration;
        try {
          await resolved.startPromise;
        } catch (err) {
          if (pendingGeneration === generation) {
            throw err;
          }
        }
        if (startCancelled() || hasStarted()) {
          return;
        }
        if (pendingGeneration !== generation) {
          await cron.start();
          return;
        }
      }
      resolved.phase = "starting";
      resolved.startGeneration = generation;
      const startPromise = (async () => {
        await waitForSchedulingResume();
        if (startCancelled()) {
          resolved.phase = "stopped";
          return;
        }
        if (resolved.schedulingPaused) {
          resolved.state.cron.resumeScheduling();
          resolved.schedulingPaused = false;
        }
        resolved.underlyingStartInFlight = true;
        try {
          await resolved.state.cron.start();
          resolved.underlyingStarted = true;
        } catch (err) {
          resolved.underlyingStarted = false;
          resolved.phase = startCancelled() ? "stopped" : "idle";
          throw err;
        } finally {
          resolved.underlyingStartInFlight = false;
        }
        if (startCancelled()) {
          resolved.phase = "stopped";
          resolved.underlyingStarted = false;
          resolved.state.cron.stop();
          resolved.state.stopExitWatchers?.();
          await resolved.state.stopStreamWatchers?.();
          return;
        }
        if (schedulingPaused) {
          resolved.state.cron.pauseScheduling();
          resolved.schedulingPaused = true;
        }
        // Arm process watchers for jobs loaded from the store at startup (no
        // change event fires for already-persisted jobs).
        try {
          if (resolved.state.cronEnabled) {
            await Promise.all([
              resolved.state.reconcileExitWatchers?.(),
              resolved.state.reconcileStreamWatchers?.(),
            ]);
          }
        } catch (err) {
          resolved.phase = startCancelled() ? "stopped" : "started";
          throw err;
        }
        if (startCancelled()) {
          resolved.phase = "stopped";
          resolved.underlyingStarted = false;
          resolved.state.cron.stop();
          resolved.state.stopExitWatchers?.();
          await resolved.state.stopStreamWatchers?.();
          return;
        }
        resolved.phase = "started";
      })();
      resolved.startPromise = startPromise;
      try {
        await startPromise;
      } finally {
        if (resolved.startPromise === startPromise) {
          resolved.startPromise = null;
          resolved.startGeneration = null;
        }
      }
    },
    stop() {
      stopped = true;
      lifecycleGeneration += 1;
      releaseSchedulingResumeWaiters();
      if (loaded) {
        loaded.phase = "stopped";
        loaded.underlyingStarted = false;
        loaded.state.cron.stop();
        loaded.state.stopExitWatchers?.();
        void loaded.state.stopStreamWatchers?.().catch(() => {});
        return;
      }
      const loading = cronStateLoader.peek();
      if (loading) {
        // Stop may happen while the dynamic import is still in flight; attach a
        // cleanup continuation instead of forcing cron to load synchronously.
        void loading
          .then((resolved) => {
            if (!stopped) {
              return;
            }
            resolved.phase = "stopped";
            resolved.underlyingStarted = false;
            resolved.state.cron.stop();
            resolved.state.stopExitWatchers?.();
            void resolved.state.stopStreamWatchers?.().catch(() => {});
          })
          .catch(() => {});
      }
    },
    async stopAndDrain() {
      stopped = true;
      lifecycleGeneration += 1;
      releaseSchedulingResumeWaiters();
      const resolved = loaded ?? (cronStateLoader.peek() ? await cronStateLoader.peek() : null);
      if (!resolved) {
        return;
      }
      resolved.phase = "stopped";
      resolved.underlyingStarted = false;
      if (resolved.state.cron.stopAndDrain) {
        await resolved.state.cron.stopAndDrain();
      } else {
        resolved.state.cron.stop();
        resolved.state.stopExitWatchers?.();
        await resolved.state.stopStreamWatchers?.();
      }
    },
    pauseScheduling() {
      schedulingPaused = true;
      if (loaded) {
        loaded.state.cron.pauseScheduling();
        loaded.schedulingPaused = true;
      }
    },
    resumeScheduling() {
      schedulingPaused = false;
      releaseSchedulingResumeWaiters();
      if (
        loaded &&
        loaded.schedulingPaused &&
        (loaded.underlyingStarted || loaded.underlyingStartInFlight)
      ) {
        loaded.state.cron.resumeScheduling();
        loaded.schedulingPaused = false;
      }
    },
    getSuspensionBlockerCount() {
      const loadedBlockers = loaded?.state.cron.getSuspensionBlockerCount?.() ?? 0;
      return loaded?.phase === "starting" ? Math.max(1, loadedBlockers) : loadedBlockers;
    },
    async status() {
      return await (await load()).state.cron.status();
    },
    async list(opts) {
      return await (await load()).state.cron.list(opts);
    },
    async listPage(opts) {
      return await (await load()).state.cron.listPage(opts);
    },
    async add(input, opts) {
      return await (await load()).state.cron.add(input, opts);
    },
    async update(id, patch) {
      return await (await load()).state.cron.update(id, patch);
    },
    async updateWithPrecondition(id, patch, precondition) {
      return await (await load()).state.cron.updateWithPrecondition(id, patch, precondition);
    },
    async remove(id) {
      return await (await load()).state.cron.remove(id);
    },
    async removeAgentJobsTransactional(agentId, commit) {
      return await (await load()).state.cron.removeAgentJobsTransactional(agentId, commit);
    },
    async run(id, mode, opts) {
      return await (await load()).state.cron.run(id, mode, opts);
    },
    async enqueueRun(id, mode) {
      return await (await load()).state.cron.enqueueRun(id, mode);
    },
    getJob(id) {
      if (!loaded) {
        return undefined;
      }
      return loaded.state.cron.getJob(id);
    },
    async readJob(id) {
      return await (await load()).state.cron.readJob(id);
    },
    async readScratch(id) {
      return await (await load()).state.cron.readScratch(id);
    },
    async writeScratch(id, write) {
      return await (await load()).state.cron.writeScratch(id, write);
    },
    getDefaultAgentId() {
      if (!loaded) {
        return undefined;
      }
      return loaded.state.cron.getDefaultAgentId();
    },
    wake(opts) {
      if (!loaded) {
        // A wake should kick off lazy loading but cannot claim success before
        // cron exists and knows whether the target job is wakeable.
        void load();
        return { ok: false };
      }
      return loaded.state.cron.wake(opts);
    },
  };

  return {
    cron,
    storePath,
    cronEnabled,
  };
}
