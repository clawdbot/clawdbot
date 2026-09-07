import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { RecordInboundSession } from "../session.types.js";
import { hasFinalChannelTurnDispatch } from "./dispatch-result.js";
import { runChannelTurn } from "./run-channel-turn.js";

function createCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    From: "sender",
    To: "target",
    SessionKey: "agent:main:test:peer",
    Provider: "test",
    Surface: "test",
    ...overrides,
  } as FinalizedMsgContext;
}

function createRecordInboundSession(events: string[] = []): RecordInboundSession {
  return vi.fn(async () => {
    events.push("record");
  }) as unknown as RecordInboundSession;
}

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

type FinalizeResult = {
  admission?: unknown;
  dispatched?: boolean;
};

function finalizeResult(value: unknown): FinalizeResult {
  return value as FinalizeResult;
}

describe("prepared channel turn lifecycle", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(
      tempDirs.make("openclaw-channel-turn-prepared-lifecycle-"),
      "sessions.json",
    );
  });

  it("runs custom prepared dispatch from a full turn adapter", async () => {
    const events: string[] = [];
    const result = await runChannelTurn({
      channel: "test",
      raw: { id: "msg-1", text: "hello" },
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        resolveTurn: () => ({
          channel: "test",
          routeSessionKey: "agent:main:test:peer",
          storePath,
          ctxPayload: createCtx(),
          recordInboundSession: createRecordInboundSession(events),
          runDispatch: async () => {
            events.push("custom-dispatch");
            return {
              queuedFinal: true,
              counts: { tool: 0, block: 0, final: 1 },
            };
          },
          runDispatchLifecycle: {
            turnAdoptionLifecycle: undefined,
            onDispatchSkipped: vi.fn(),
          },
        }),
      },
    });

    expect(events).toEqual(["record", "custom-dispatch"]);
    expect(result.dispatched).toBe(true);
    if (!result.dispatched) {
      throw new Error("expected dispatch");
    }
    expect(result.dispatchResult.queuedFinal).toBe(true);
  });

  it("rejects prepared turns that omit dispatch lifecycle ownership when the caller adopts a durable ingress claim", async () => {
    const recordInboundSession = createRecordInboundSession();
    const runDispatch = vi.fn(async () => ({ visibleReplySent: true }));
    const onFinalize = vi.fn();
    const turnAdoptionLifecycle = { onAdopted: vi.fn(async () => undefined) };

    await expect(
      runChannelTurn({
        channel: "test",
        raw: { id: "msg-1", text: "hello" },
        turnAdoptionLifecycle,
        adapter: {
          ingest: () => ({ id: "msg-1", rawText: "hello" }),
          resolveTurn: () => {
            const turn = {
              channel: "test",
              routeSessionKey: "agent:main:test:peer",
              storePath,
              ctxPayload: createCtx(),
              recordInboundSession,
              runDispatch,
              runDispatchLifecycle: {
                turnAdoptionLifecycle,
                onDispatchSkipped: vi.fn(),
              },
            };
            Object.defineProperty(turn, "runDispatchLifecycle", { value: undefined });
            return turn;
          },
          onFinalize,
        },
      }),
    ).rejects.toThrow("runChannelInboundEvent prepared turns must declare runDispatchLifecycle");

    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(runDispatch).not.toHaveBeenCalled();
    expect(onFinalize).toHaveBeenCalledWith(
      expect.objectContaining({ admission: { kind: "dispatch" }, dispatched: false }),
    );
  });

  it("rejects a prepared dispatch lifecycle that does not own the top-level adoption", async () => {
    const recordInboundSession = createRecordInboundSession();
    const runDispatch = vi.fn(async () => ({ visibleReplySent: true }));
    const onFinalize = vi.fn();

    await expect(
      runChannelTurn({
        channel: "test",
        raw: { id: "msg-1", text: "hello" },
        turnAdoptionLifecycle: { onAdopted: vi.fn(async () => undefined) },
        adapter: {
          ingest: () => ({ id: "msg-1", rawText: "hello" }),
          resolveTurn: () => ({
            channel: "test",
            routeSessionKey: "agent:main:test:peer",
            storePath,
            ctxPayload: createCtx(),
            recordInboundSession,
            runDispatch,
            runDispatchLifecycle: {
              turnAdoptionLifecycle: undefined,
              onDispatchSkipped: vi.fn(),
            },
          }),
          onFinalize,
        },
      }),
    ).rejects.toThrow(
      "runChannelInboundEvent prepared turn runDispatchLifecycle must own the top-level turnAdoptionLifecycle",
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(runDispatch).not.toHaveBeenCalled();
    expect(onFinalize).toHaveBeenCalledWith(
      expect.objectContaining({ admission: { kind: "dispatch" }, dispatched: false }),
    );
  });

  it("runs a prepared turn whose dispatch lifecycle owns the top-level adoption", async () => {
    const onAdopted = vi.fn(async () => undefined);
    const turnAdoptionLifecycle = { onAdopted };
    const runDispatch = vi.fn(async () => {
      await turnAdoptionLifecycle.onAdopted();
      return { visibleReplySent: true };
    });

    const result = await runChannelTurn({
      channel: "test",
      raw: { id: "msg-1", text: "hello" },
      turnAdoptionLifecycle,
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        resolveTurn: () => ({
          channel: "test",
          routeSessionKey: "agent:main:test:peer",
          storePath,
          ctxPayload: createCtx(),
          recordInboundSession: createRecordInboundSession(),
          runDispatch,
          runDispatchLifecycle: {
            turnAdoptionLifecycle,
            onDispatchSkipped: vi.fn(),
          },
        }),
      },
    });

    expect(result.dispatched).toBe(true);
    expect(runDispatch).toHaveBeenCalledOnce();
    expect(onAdopted).toHaveBeenCalledOnce();
  });

  it.each(["draft lane", "typing indicator", "delivery correlation"])(
    "settles a prepared %s when observe-only suppresses dispatch",
    async () => {
      const events: string[] = [];
      const onFinalize = vi.fn();
      let resourceOpen = true;
      const onDispatchSkipped = vi.fn(async () => {
        resourceOpen = false;
        events.push("cleanup");
      });
      const runDispatch = vi.fn(async () => {
        events.push("custom-dispatch");
        return {
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
        };
      });
      const result = await runChannelTurn({
        channel: "test",
        raw: { id: "msg-1", text: "hello" },
        adapter: {
          ingest: () => ({ id: "msg-1", rawText: "hello" }),
          preflight: () => ({ kind: "observeOnly", reason: "broadcast-observer" }),
          resolveTurn: () => ({
            channel: "test",
            routeSessionKey: "agent:observer:test:peer",
            storePath,
            ctxPayload: createCtx({ SessionKey: "agent:observer:test:peer" }),
            recordInboundSession: createRecordInboundSession(events),
            runDispatch,
            runDispatchLifecycle: {
              turnAdoptionLifecycle: undefined,
              onDispatchSkipped,
            },
          }),
          onFinalize,
        },
      });

      expect(result.admission).toEqual({ kind: "observeOnly", reason: "broadcast-observer" });
      expect(result.dispatched).toBe(true);
      expect(events).toEqual(["record", "cleanup"]);
      expect(runDispatch).not.toHaveBeenCalled();
      expect(onDispatchSkipped).toHaveBeenCalledWith("observeOnly");
      expect(resourceOpen).toBe(false);
      if (!result.dispatched) {
        throw new Error("expected dispatch");
      }
      expect(hasFinalChannelTurnDispatch(result.dispatchResult)).toBe(false);
      expect(onFinalize).toHaveBeenCalledTimes(1);
      const [finalized] = requireFirstMockCall(onFinalize, "finalize");
      const finalizedResult = finalizeResult(finalized);
      expect(finalizedResult.admission).toEqual({
        kind: "observeOnly",
        reason: "broadcast-observer",
      });
      expect(finalizedResult.dispatched).toBe(true);
    },
  );
});
