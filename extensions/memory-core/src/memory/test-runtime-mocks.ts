// Memory Core plugin module implements test runtime mocks behavior.
import { afterAll, beforeAll, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";

const nativeWatchFactoryKey = Symbol.for("openclaw.test.memoryNativeWatchFactory");
let originalNativeWatchFactory: PropertyDescriptor | undefined;

// Memory indexing reads flush provenance from plugin state. Manager tests use
// this shared setup instead of booting the full plugin runtime.
beforeAll(async () => {
  // Native directory watchers bypass chokidar. These manually driven fixtures
  // must silence both event sources so host events cannot create extra sync generations.
  originalNativeWatchFactory = Object.getOwnPropertyDescriptor(globalThis, nativeWatchFactoryKey);
  Object.defineProperty(globalThis, nativeWatchFactoryKey, {
    configurable: true,
    writable: true,
    value: createWatcherMock,
  });
  await configureMemoryCoreDreamingStateForTests();
});

afterAll(() => {
  if (originalNativeWatchFactory) {
    Object.defineProperty(globalThis, nativeWatchFactoryKey, originalNativeWatchFactory);
  } else {
    Reflect.deleteProperty(globalThis, nativeWatchFactoryKey);
  }
  resetMemoryCoreDreamingStateForTests();
});

// Unit tests: avoid importing the real chokidar implementation (native fsevents, etc.).
function createWatcherMock() {
  const watcher = {
    on: () => watcher,
    once: () => watcher,
    add: () => watcher,
    unwatch: async () => watcher,
    close: async () => undefined,
    getWatched: () => ({}),
  };
  return watcher;
}

vi.mock("chokidar", () => ({
  default: { watch: createWatcherMock },
  watch: createWatcherMock,
}));
