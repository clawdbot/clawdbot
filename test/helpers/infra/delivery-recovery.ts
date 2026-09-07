// Controls mocked recovery sleeps so tests prove callers stay blocked until release.
import { vi } from "vitest";

type SleepMock = {
  mockImplementation(implementation: (ms: number) => Promise<void>): unknown;
};

export function controlNextRecoverySleep(sleepMock: SleepMock) {
  let releaseSleep: (() => void) | undefined;
  const started = new Promise<number>((resolveStarted) => {
    sleepMock.mockImplementation(
      (ms) =>
        new Promise<void>((resolve) => {
          releaseSleep = () => {
            vi.setSystemTime(Date.now() + ms);
            resolve();
          };
          resolveStarted(ms);
        }),
    );
  });
  return {
    started,
    release() {
      if (!releaseSleep) {
        throw new Error("Expected recovery sleep to start before release");
      }
      releaseSleep();
    },
  };
}
