import { channel } from "node:diagnostics_channel";
import { BroadcastChannel, type Worker } from "node:worker_threads";
import { onTestFinished } from "vitest";
import { createDeferred } from "./promise.js";

/** Resolve the real worker that reports its threadId on a private activity channel. */
export function observeWorkerActivity(channelName: string): Promise<Worker> {
  const workers = new Map<number, Worker>();
  const workerChannel = channel("worker_threads");
  const track = (message: unknown) => {
    const { worker } = message as { worker: Worker };
    workers.set(worker.threadId, worker);
  };
  workerChannel.subscribe(track);
  const activity = new BroadcastChannel(channelName);
  onTestFinished(() => {
    workerChannel.unsubscribe(track);
    activity.close();
  });
  const observed = createDeferred<Worker>();
  activity.addEventListener(
    "message",
    ({ data }) => {
      const worker = workers.get(data);
      if (worker) {
        observed.resolve(worker);
      } else {
        observed.reject(new Error(`Activity came from an unobserved worker: ${String(data)}`));
      }
    },
    { once: true },
  );
  return observed.promise;
}
