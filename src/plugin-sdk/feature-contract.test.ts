import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  createFeatureClient,
  defineFeatureContract,
  type FeatureTransport,
} from "./feature-contract.js";

const contract = defineFeatureContract({
  pluginId: "feature-fixture",
  operations: {
    inspect: {
      kind: "query",
      description: "Inspect",
      input: Type.Object({}),
      output: Type.String(),
    },
    update: { kind: "action", description: "Update", input: Type.Object({}), output: Type.Null() },
  },
  events: { changed: Type.Object({}) },
});

function hostFixture() {
  const controller = new AbortController();
  const events = new Map<string, (payload: unknown) => void>();
  const listeners = new Set<() => void>();
  const pending: Array<(value: unknown) => void> = [];
  const host = {
    pluginId: contract.pluginId,
    signal: controller.signal,
    connection: { connected: true },
    request: vi.fn<FeatureTransport["request"]>(
      <T>() =>
        new Promise<T>((resolve) => {
          pending.push((value) => resolve(value as T));
        }),
    ),
    onEvent: (event: string, listener: (payload: unknown) => void) => {
      events.set(event, listener);
      return () => {
        events.delete(event);
      };
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    host,
    pending,
    events,
    listeners,
    controller,
    client: createFeatureClient(contract, host),
  };
}

describe("feature browser client", () => {
  it("refreshes watched queries on events and reconnect while fencing stale results", async () => {
    const fixture = hostFixture();
    const onChange = vi.fn();
    const onError = vi.fn();
    const dispose = fixture.client.watch(
      "inspect",
      {},
      { events: ["changed"], onChange, onError, sessionKey: "agent:fixture:task" },
    );
    await Promise.resolve();
    expect(fixture.host.request).toHaveBeenCalledWith("plugins.sessionAction", {
      pluginId: contract.pluginId,
      actionId: "inspect",
      payload: {},
      sessionKey: "agent:fixture:task",
      agentId: undefined,
    });
    fixture.events.get("plugin.feature-fixture.changed")?.({});
    await Promise.resolve();
    fixture.pending[0]?.({ ok: true, result: "stale" });
    fixture.pending[1]?.({ ok: true, result: "current" });
    await Promise.resolve();
    await Promise.resolve();
    expect(onChange.mock.calls).toEqual([["current"]]);

    fixture.host.connection.connected = false;
    for (const listener of fixture.listeners) {
      listener();
    }
    fixture.events.get("plugin.feature-fixture.changed")?.({});
    await Promise.resolve();
    expect(fixture.host.request).toHaveBeenCalledTimes(2);
    fixture.host.connection.connected = true;
    for (const listener of fixture.listeners) {
      listener();
    }
    await Promise.resolve();
    expect(fixture.host.request).toHaveBeenCalledTimes(3);
    fixture.pending[2]?.({ ok: false, error: "query unavailable" });
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "query unavailable" }));
    dispose();
    expect(fixture.events.size).toBe(0);
    expect(fixture.listeners.size).toBe(0);
  });

  it("disposes event subscriptions and in-flight deliveries with the browser owner", async () => {
    const fixture = hostFixture();
    const onChange = vi.fn();
    const onError = vi.fn();
    fixture.client.watch("inspect", {}, { events: ["changed"], onChange, onError });
    await Promise.resolve();
    fixture.controller.abort();
    fixture.pending[0]?.({ ok: true, result: "late" });
    await Promise.resolve();
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(fixture.events.size).toBe(0);
    expect(fixture.listeners.size).toBe(0);
  });
});
