/** Polls an active update campaign without overlapping timers. */
export function createUpdateCampaignStatusPoller(params: {
  canPoll: () => boolean;
  refresh: () => Promise<void>;
}) {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let generation = 0;
  const stop = () => {
    generation += 1;
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
  };
  const poll = async () => {
    timer = null;
    const currentGeneration = generation;
    if (params.canPoll()) {
      await params.refresh();
    }
    if (currentGeneration === generation) {
      sync();
    }
  };
  const sync = () => {
    if (!params.canPoll()) {
      stop();
      return;
    }
    if (timer === null) {
      timer = globalThis.setTimeout(() => void poll(), 5_000);
    }
  };
  return { stop, sync };
}
