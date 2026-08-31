import { describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import {
  createPluginSubagentRequesterContext,
  resolvePluginSubagentCompletionRequester,
  type PluginSubagentRequesterContext,
} from "./runtime/subagent-requester-context.js";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function getActiveRequester(): PluginSubagentRequesterContext | undefined {
  try {
    return resolvePluginSubagentCompletionRequester("current-requester");
  } catch {
    return undefined;
  }
}

describe("before_dispatch requester authority", () => {
  it("expires each plugin scope before the next handler settles", async () => {
    const requester = createPluginSubagentRequesterContext({
      sessionKey: "agent:main:telegram:direct:123",
      origin: { channel: "telegram", to: "telegram:123" },
    });
    if (!requester) {
      throw new Error("expected valid requester context");
    }

    const detachedGate = deferred();
    const secondStarted = deferred();
    const releaseSecond = deferred();
    let detachedRead: Promise<PluginSubagentRequesterContext | undefined> | undefined;
    const registry = createMockPluginRegistry([
      {
        hookName: "before_dispatch",
        pluginId: "first",
        priority: 100,
        handler: async () => {
          expect(getActiveRequester()).toBe(requester);
          detachedRead = (async () => {
            await detachedGate.promise;
            return getActiveRequester();
          })();
          return { handled: false };
        },
      },
      {
        hookName: "before_dispatch",
        pluginId: "second",
        priority: 0,
        handler: async () => {
          expect(getActiveRequester()).toBe(requester);
          secondStarted.resolve();
          await releaseSecond.promise;
          return { handled: false };
        },
      },
    ]);

    const run = createHookRunner(registry).runBeforeDispatch({ content: "hello" }, {}, requester);
    await secondStarted.promise;
    detachedGate.resolve();
    if (!detachedRead) {
      throw new Error("expected detached requester read");
    }
    await expect(detachedRead).resolves.toBeUndefined();

    releaseSecond.resolve();
    await expect(run).resolves.toBeUndefined();
    expect(getActiveRequester()).toBeUndefined();
  });
});
