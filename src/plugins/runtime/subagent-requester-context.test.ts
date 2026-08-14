import { describe, expect, it } from "vitest";
import {
  createPluginSubagentRequesterContext,
  resolvePluginSubagentCompletionRequester,
  type PluginSubagentRequesterContext,
  withPluginSubagentRequesterContext,
} from "./subagent-requester-context.js";

function getActiveRequester(): PluginSubagentRequesterContext | undefined {
  try {
    return resolvePluginSubagentCompletionRequester("current-requester");
  } catch {
    return undefined;
  }
}

describe("plugin subagent requester context", () => {
  it("normalizes and freezes host-owned requester lineage", () => {
    const requester = createPluginSubagentRequesterContext({
      sessionKey: "  agent:main:telegram:direct:123  ",
      origin: {
        channel: " Telegram ",
        to: " telegram:123 ",
        accountId: " Work ",
        threadId: 42,
      },
    });

    expect(requester).toEqual({
      sessionKey: "agent:main:telegram:direct:123",
      origin: {
        channel: "telegram",
        to: "telegram:123",
        accountId: "work",
        threadId: 42,
      },
    });
    expect(Object.isFrozen(requester)).toBe(true);
    expect(Object.isFrozen(requester?.origin)).toBe(true);
  });

  it("rejects missing or invalid requester lineage", () => {
    expect(
      createPluginSubagentRequesterContext({
        origin: { channel: "telegram", to: "telegram:123" },
      }),
    ).toBeUndefined();
    expect(
      createPluginSubagentRequesterContext({
        sessionKey: "agent:main:telegram:direct:123",
        origin: { channel: "telegram" },
      }),
    ).toBeUndefined();
  });

  it("expires requester authority when the hook invocation returns", async () => {
    const requester = createPluginSubagentRequesterContext({
      sessionKey: "agent:main:telegram:direct:123",
      origin: { channel: "telegram", to: "telegram:123" },
    });
    if (!requester) {
      throw new Error("expected valid requester context");
    }

    let releaseDetachedRead: (() => void) | undefined;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetachedRead = resolve;
    });
    let detachedRead: Promise<PluginSubagentRequesterContext | undefined> | undefined;
    await withPluginSubagentRequesterContext(requester, async () => {
      expect(getActiveRequester()).toBe(requester);
      detachedRead = (async () => {
        await detachedGate;
        return getActiveRequester();
      })();
    });

    releaseDetachedRead?.();
    await expect(detachedRead).resolves.toBeUndefined();
    expect(getActiveRequester()).toBeUndefined();
  });

  it("isolates concurrent requester scopes", async () => {
    const first = createPluginSubagentRequesterContext({
      sessionKey: "agent:main:telegram:direct:first",
      origin: { channel: "telegram", to: "telegram:first", accountId: "first" },
    });
    const second = createPluginSubagentRequesterContext({
      sessionKey: "agent:main:telegram:direct:second",
      origin: { channel: "telegram", to: "telegram:second", accountId: "second" },
    });
    if (!first || !second) {
      throw new Error("expected valid requester contexts");
    }

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstReady: (() => void) | undefined;
    let secondReady: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstReady = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      secondReady = resolve;
    });

    const firstRun = withPluginSubagentRequesterContext(first, async () => {
      expect(getActiveRequester()).toBe(first);
      firstReady?.();
      await gate;
      expect(getActiveRequester()).toBe(first);
    });
    const secondRun = withPluginSubagentRequesterContext(second, async () => {
      expect(getActiveRequester()).toBe(second);
      secondReady?.();
      await gate;
      expect(getActiveRequester()).toBe(second);
    });

    await Promise.all([firstStarted, secondStarted]);
    release?.();
    await Promise.all([firstRun, secondRun]);
    expect(getActiveRequester()).toBeUndefined();
  });
});
