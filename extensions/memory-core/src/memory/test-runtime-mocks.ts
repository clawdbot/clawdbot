// Memory Core plugin module implements test runtime mocks behavior.
import { afterAll, beforeAll, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";

// Memory indexing reads flush provenance from plugin state. Manager tests use
// this shared setup instead of booting the full plugin runtime.
beforeAll(async () => {
  await configureMemoryCoreDreamingStateForTests();
});

afterAll(() => {
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
