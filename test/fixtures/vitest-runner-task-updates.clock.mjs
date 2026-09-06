// A dedicated worker preload installs the clock before Vitest captures safe
// timers. Only the producer's 100ms throttle is driven manually; deadlines stay real.
const timers = new Set();
let clock = 1_000;
const nativeTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
Date.now = () => clock;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay !== 100) return nativeTimeout(callback, delay, ...args);
  const timer = { delay, callback: () => callback(...args) };
  timers.add(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => {
  if (!timers.delete(timer)) nativeClearTimeout(timer);
};
globalThis[Symbol.for("vitest.task-update-clock")] = {
  pendingDelays: () => [...timers].map((timer) => timer.delay),
  fire(elapsed) {
    clock = 1_000 + elapsed;
    for (const timer of [...timers]) {
      timers.delete(timer);
      timer.callback();
    }
  },
};
