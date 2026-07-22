// Memory Core plugin module implements test runtime mocks behavior.
import { vi } from "vitest";

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
