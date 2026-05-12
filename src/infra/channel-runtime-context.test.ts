import { describe, expect, it, vi } from "vitest";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import {
  createTaskScopedChannelRuntime,
  getChannelRuntimeContext,
  registerChannelRuntimeContext,
  watchChannelRuntimeContexts,
} from "./channel-runtime-context.js";

describe("channel runtime context helpers", () => {
  it("returns inert helpers when no channel runtime exists", () => {
    expect(
      registerChannelRuntimeContext({
        channelId: "slack",
        accountId: "default",
        capability: "approval.native",
        context: { ok: true },
      }),
    ).toBeNull();
    expect(
      getChannelRuntimeContext({
        channelId: "slack",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(
      watchChannelRuntimeContexts({
        channelId: "slack",
        accountId: "default",
        capability: "approval.native",
        onEvent: vi.fn(),
      }),
    ).toBeNull();

    const scoped = createTaskScopedChannelRuntime({});
    expect(scoped.channelRuntime).toBeUndefined();
    expect(scoped.dispose()).toBeUndefined();
  });

  it("disposes only task-scoped registrations", () => {
    const channelRuntime = createRuntimeChannel();
    const onEvent = vi.fn();
    const unsubscribe = watchChannelRuntimeContexts({
      channelRuntime,
      channelId: "slack",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });
    const persistentLease = registerChannelRuntimeContext({
      channelRuntime,
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "matrix" },
    });
    const scoped = createTaskScopedChannelRuntime({ channelRuntime });

    registerChannelRuntimeContext({
      channelRuntime: scoped.channelRuntime,
      channelId: "slack",
      accountId: "default",
      capability: "approval.native",
      context: { app: "slack" },
    });

    expect(
      getChannelRuntimeContext({
        channelRuntime,
        channelId: "slack",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({ app: "slack" });
    expect(
      getChannelRuntimeContext({
        channelRuntime,
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({ client: "matrix" });

    scoped.dispose();

    expect(
      getChannelRuntimeContext({
        channelRuntime,
        channelId: "slack",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(
      getChannelRuntimeContext({
        channelRuntime,
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({ client: "matrix" });
    expect(onEvent.mock.calls).toEqual([
      [
        {
          type: "registered",
          key: {
            channelId: "slack",
            accountId: "default",
            capability: "approval.native",
          },
          context: { app: "slack" },
        },
      ],
      [
        {
          type: "unregistered",
          key: {
            channelId: "slack",
            accountId: "default",
            capability: "approval.native",
          },
        },
      ],
    ]);

    persistentLease?.dispose();
    unsubscribe?.();
  });
});
