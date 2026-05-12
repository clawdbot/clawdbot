import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import { resolveCronStorePath } from "../cron/store.js";
import type { GatewayCronState } from "./server-cron.js";

type LazyGatewayCronParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
};

type LoadedGatewayCronState = {
  state: GatewayCronState;
  started: boolean;
};

export function createLazyGatewayCronState(params: LazyGatewayCronParams): GatewayCronState {
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;
  let loaded: LoadedGatewayCronState | null = null;
  let loading: Promise<LoadedGatewayCronState> | null = null;
  let stopped = false;

  const load = async (): Promise<LoadedGatewayCronState> => {
    if (loaded) {
      return loaded;
    }
    loading ??= import("./server-cron.js").then(({ buildGatewayCronService }) => {
      loaded = {
        state: buildGatewayCronService(params),
        started: false,
      };
      return loaded;
    });
    return await loading;
  };

  const cron: CronServiceContract = {
    async start() {
      stopped = false;
      const resolved = await load();
      if (stopped) {
        return;
      }
      if (resolved.started) {
        return;
      }
      resolved.started = true;
      await resolved.state.cron.start();
      if (stopped && resolved.started) {
        resolved.started = false;
        resolved.state.cron.stop();
      }
    },
    stop() {
      stopped = true;
      if (loaded) {
        loaded.started = false;
        loaded.state.cron.stop();
        return;
      }
      if (loading) {
        void loading
          .then((resolved) => {
            if (!stopped) {
              return;
            }
            resolved.started = false;
            resolved.state.cron.stop();
          })
          .catch(() => {});
      }
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
    async add(input) {
      return await (await load()).state.cron.add(input);
    },
    async update(id, patch) {
      return await (await load()).state.cron.update(id, patch);
    },
    async remove(id) {
      return await (await load()).state.cron.remove(id);
    },
    async run(id, mode) {
      return await (await load()).state.cron.run(id, mode);
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
    getDefaultAgentId() {
      if (!loaded) {
        return undefined;
      }
      return loaded.state.cron.getDefaultAgentId();
    },
    wake(opts) {
      if (!loaded) {
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
