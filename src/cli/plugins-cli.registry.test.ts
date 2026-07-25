import { beforeEach, describe, expect, it } from "vitest";
import {
  refreshPluginRegistry,
  resetPluginsCliTestState,
  runPluginsCommand,
} from "./plugins-cli-test-helpers.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("plugins registry refresh", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("serializes registry rebuilds with other plugin lifecycle mutations", async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const entries: number[] = [];
    refreshPluginRegistry.mockImplementation(async () => {
      const entry = entries.length + 1;
      entries.push(entry);
      if (entry === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return { plugins: [] };
    });

    const first = runPluginsCommand(["plugins", "registry", "--refresh", "--json"]);
    await firstEntered.promise;
    const second = runPluginsCommand(["plugins", "registry", "--refresh", "--json"]);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(entries).toEqual([1]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(entries).toEqual([1, 2]);
  });
});
