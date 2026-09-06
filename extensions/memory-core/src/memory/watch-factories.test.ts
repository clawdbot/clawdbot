import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryWatchFactory } from "./watch-factories.js";

const originalPollingEnv = process.env.CHOKIDAR_USEPOLLING;

afterEach(() => {
  if (originalPollingEnv === undefined) {
    delete process.env.CHOKIDAR_USEPOLLING;
  } else {
    process.env.CHOKIDAR_USEPOLLING = originalPollingEnv;
  }
});

describe("memory watcher factories", () => {
  it("forces polling for capacity recovery when the environment disables it", async () => {
    process.env.CHOKIDAR_USEPOLLING = "0";

    const watcher = resolveMemoryWatchFactory(true)([], { ignoreInitial: true });

    try {
      expect(watcher.options.usePolling).toBe(true);
      expect(process.env.CHOKIDAR_USEPOLLING).toBe("0");
    } finally {
      await watcher.close();
    }
  });
});
