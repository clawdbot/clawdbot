import { describe, expect, it } from "vitest";
import type { AcpRuntime } from "../runtime/types.js";
import type { AcpRuntimeHandle } from "../runtime/types.js";
import type { CachedRuntimeState } from "./runtime-cache.js";
import { RuntimeCache } from "./runtime-cache.js";

function mockState(sessionKey: string): CachedRuntimeState {
  const runtime = {
    async ensureSession() {
      return {
        sessionKey,
        backend: "acpx",
        runtimeSessionName: `runtime:${sessionKey}`,
      };
    },
    async *runTurn() {
      yield { type: "done" as const };
    },
    async cancel() {},
    async close() {},
  } satisfies AcpRuntime;
  return {
    runtime,
    handle: {
      sessionKey,
      backend: "acpx",
      runtimeSessionName: `runtime:${sessionKey}`,
    } as AcpRuntimeHandle,
    backend: "acpx",
    agent: "codex",
    mode: "persistent",
  };
}

describe("RuntimeCache", () => {
  it("tracks idle candidates with touch-aware lookups", () => {
    const cache = new RuntimeCache();
    const actor = "agent:codex:acp:s1";
    cache.set(actor, mockState(actor), { now: 1_000 });

    expect(cache.collectIdleCandidates({ maxIdleMs: 1_000, now: 1_999 })).toHaveLength(0);
    expect(cache.collectIdleCandidates({ maxIdleMs: 1_000, now: 2_000 })).toHaveLength(1);

    cache.get(actor, { now: 2_500 });
    expect(cache.collectIdleCandidates({ maxIdleMs: 1_000, now: 3_200 })).toHaveLength(0);
    expect(cache.collectIdleCandidates({ maxIdleMs: 1_000, now: 3_500 })).toHaveLength(1);
  });

  it("returns snapshot entries with idle durations", () => {
    const cache = new RuntimeCache();
    cache.set("a", mockState("a"), { now: 10 });
    cache.set("b", mockState("b"), { now: 100 });

    const snapshot = cache.snapshot({ now: 1_100 });
    const byActor = new Map(snapshot.map((entry) => [entry.actorKey, entry]));
    expect(byActor.get("a")?.idleMs).toBe(1_090);
    expect(byActor.get("b")?.idleMs).toBe(1_000);
  });
});
