import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntime } from "../runtime-api.js";
import { AcpxRuntime } from "./runtime.js";

type TestSessionStore = {
  load(sessionId: string): Promise<Record<string, unknown> | undefined>;
  save(record: Record<string, unknown>): Promise<void>;
};

function makeRuntime(baseStore: TestSessionStore): {
  runtime: AcpxRuntime;
  wrappedStore: TestSessionStore & { markFresh: (sessionKey: string) => void };
  delegate: { close: AcpRuntime["close"] };
} {
  const runtime = new AcpxRuntime({
    cwd: "/tmp",
    sessionStore: baseStore,
    agentRegistry: {
      resolve: () => "codex",
      list: () => ["codex"],
    },
    permissionMode: "approve-reads",
  });

  return {
    runtime,
    wrappedStore: (
      runtime as unknown as {
        sessionStore: TestSessionStore & { markFresh: (sessionKey: string) => void };
      }
    ).sessionStore,
    delegate: (runtime as unknown as { delegate: { close: AcpRuntime["close"] } }).delegate,
  };
}

describe("AcpxRuntime fresh reset wrapper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps stale persistent loads hidden until a fresh record is saved", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const { runtime, wrappedStore } = makeRuntime(baseStore);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(1);

    await runtime.prepareFreshSession({
      sessionKey: "agent:codex:acp:binding:test",
    });

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledTimes(1);
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledTimes(1);

    await wrappedStore.save({
      acpxRecordId: "fresh-record",
      name: "agent:codex:acp:binding:test",
    } as never);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(2);
  });

  it("marks the session fresh after discardPersistentState close", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const { runtime, wrappedStore, delegate } = makeRuntime(baseStore);
    const close = vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });

    expect(close).toHaveBeenCalledWith({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).not.toHaveBeenCalled();
  });
});
