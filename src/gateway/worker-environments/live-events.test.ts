import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  WorkerLiveEventErrorDetails as ErrorDetails,
  WorkerLiveEventParams as Params,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig as Config } from "../../config/types.openclaw.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  getAgentRunContext,
  onAgentRuntimeEvent,
  sweepStaleRunContexts,
  type AgentEventRuntimePayload as Event,
} from "../../infra/agent-events.js";
import type { WorkerConnectionIdentity as Identity } from "./connection-identity.js";
import {
  createWorkerLiveEventReceiver,
  type WorkerLiveEventReceiver as Receiver,
} from "./live-events.js";

const SID = "session-worker-live";
const KEY = "agent:main:worker-live";
const EPOCH = 7;
const RUN = "run-worker-live";
const LOCAL = { agentId: "main", sessionId: SID, sessionKey: KEY };
const ID: Identity = {
  environmentId: "environment-live",
  credentialHash: ["credential", "hash", "live"].join("-"),
  bundleHash: "b".repeat(64),
  sessionId: SID,
  runId: RUN,
  ownerEpoch: EPOCH,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-live-event-v1"],
  credentialExpiresAtMs: 10_000,
};

const msg = (seq: number, delta = "hello", ack = 0, runId = RUN, epoch = EPOCH): Params => ({
  runEpoch: epoch,
  lastAckedSeq: ack,
  seq,
  runId,
  event: { kind: "assistant", payload: { text: delta, delta } },
});

function live(seq: number, event: Params["event"], runId = RUN): Params {
  return { runEpoch: EPOCH, lastAckedSeq: seq - 1, seq, runId, event };
}

const binding = ({ environmentId, ownerEpoch: runEpoch, sessionId }: Identity = ID) => ({
  environmentId,
  runEpoch,
  sessionId: sessionId ?? SID,
});

type WireEvent = Params["event"];
type Payload<K extends WireEvent["kind"]> = Extract<WireEvent, { kind: K }>["payload"];
const tool = (payload: Payload<"tool">): WireEvent => ({ kind: "tool", payload });
const approval = (payload: Payload<"approval">): WireEvent => ({ kind: "approval", payload });
const lifecycle = (payload: Payload<"lifecycle">): WireEvent => ({ kind: "lifecycle", payload });

describe("worker live events", () => {
  let root: string;
  let store: string;
  let cfg: Config;
  let rx: Receiver;
  let events: Event[];
  let unsubscribe: (() => void) | undefined;

  const ack = (request: Params, ackedSeq = request.seq, id = ID) => {
    expect(rx.apply({ identity: id, request })).toEqual({ ok: true, result: { ackedSeq } });
  };
  const fail = (request: Params, reason: ErrorDetails["reason"], id = ID) => {
    const details: ErrorDetails =
      reason === "resync-required" ? { reason, ackedSeq: 0, expectedSeq: 1 } : { reason };
    expect(rx.apply({ identity: id, request })).toEqual({ ok: false, details });
  };
  const start = (overrides: Partial<Parameters<typeof createWorkerLiveEventReceiver>[0]> = {}) => {
    rx?.clear();
    rx = createWorkerLiveEventReceiver({
      getConfig: () => cfg,
      startupBindings: [binding()],
      startupOwners: new Map([[ID.environmentId, EPOCH]]),
      ...overrides,
    });
    rx.start();
  };
  const target = { canonicalKey: KEY, storeKeys: [KEY] };
  const remove = () =>
    sessions.deleteSessionEntryLifecycle({
      agentId: "main",
      archiveTranscript: false,
      expectedSessionId: SID,
      storePath: store,
      target,
    });
  const create = (updatedAt = 20) =>
    sessions.upsertSessionEntry(
      { agentId: "main", sessionKey: KEY, storePath: store },
      { sessionId: SID, updatedAt },
    );
  const deltas = () => events.map((event) => event.data.delta);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-live-"));
    store = path.join(root, "agents", "main", "sessions", "sessions.json");
    cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: {
        mainKey: "main",
        store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    await create(10);
    start();
    events = [];
    unsubscribe = onAgentRuntimeEvent((event) => events.push(event));
  });

  afterEach(async () => {
    unsubscribe?.();
    rx.clear();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("maps and sanitizes kinds", () => {
    const credential = ["fixture", "credential", "value"].join("-");
    const output = (char: string, status: string) => ({
      content: [{ type: "image", bytes: 6, omitted: true }],
      details: { credential, status, aggregated: char.repeat(9000) },
    });
    const variants: WireEvent[] = [
      { kind: "assistant", payload: { text: "hello", delta: "hello" } },
      { kind: "thinking", payload: { text: "Inspecting", delta: "ing" } },
      tool({ phase: "start", name: "read", toolCallId: "call", args: { credential } }),
      tool({
        phase: "update",
        name: " BASH ",
        toolCallId: "call",
        partialResult: output("p", "running"),
      }),
      tool({
        phase: "result",
        name: "bash",
        toolCallId: "call",
        isError: false,
        result: output("r", "completed"),
      }),
      approval({ phase: "requested", kind: "exec", status: "pending", title: "Approve" }),
      approval({ phase: "resolved", kind: "exec", status: "approved", title: "Approved" }),
      lifecycle({ phase: "start", startedAt: 100 }),
      lifecycle({
        phase: "fallback_step",
        fallbackStepType: "fallback_step",
        fallbackStepFromModel: "openai/gpt-primary",
        fallbackStepFinalOutcome: "next_fallback",
      }),
    ];

    variants.forEach((event, index) => {
      ack(live(index + 1, event, `run-map-${index}`));
    });
    expect(events.map((event) => event.stream)).toEqual(variants.map((event) => event.kind));
    const capped = (char: string) => `${char.repeat(8000)}\n...(live output truncated)...`;
    expect(events[4]?.data).toMatchObject({
      name: "exec",
      result: { content: [{ bytes: 6, omitted: true }], details: { aggregated: capped("r") } },
    });
    expect(JSON.stringify(events)).not.toContain(credential);
  });

  it("replays an unacked tail once", () => {
    ack(msg(2, " world"), 0);
    ack(msg(1), 2, { ...ID });
    ack(msg(1), 2);
    ack(msg(2, " world"), 2);
    expect(deltas()).toEqual(["hello", " world"]);
  });

  it.each([
    ["sequence", { windowSize: 2 }, msg(3)],
    ["bytes", { maxPendingBytes: 1 }, msg(2, "buffered")],
  ])("resyncs an out-of-window %s gap", (_name, options, request) => {
    start(options);
    fail(request, "resync-required");
  });

  it("uses startup ACK once", async () => {
    ack(msg(6, "before", 5));
    await remove();
    await create(30);
    fail(msg(8, "stale", 7), "resync-required");
    ack(msg(1, "fresh"));
  });

  it("does not seed ACK for a freshly attached startup owner", () => {
    start({ startupBindings: [] });
    expect(rx.bindSession(binding())).toBe(true);
    fail(msg(6, "stale", 5), "resync-required");
    ack(msg(1));
  });

  it("rebinds unresolved startup", async () => {
    await remove();
    start();
    fail(msg(1), "session-not-attached");
    await create();
    fail(msg(6, "stale", 5), "resync-required");
    ack(msg(1));
  });

  it("rotates owners", () => {
    ack(msg(1, "first"));
    const credentialHash = ["rotated", "credential", "hash"].join("-");
    rx.rotateCredential({
      credentialHash,
      environmentId: ID.environmentId,
      previousCredentialHash: ID.credentialHash,
      runEpoch: EPOCH,
      sessionId: SID,
    });
    const rotated = { ...ID, credentialHash };
    ack(msg(2, "second", 1), 2, rotated);
    fail(msg(3, "late", 2), "epoch-mismatch");
    const next = { ...rotated, ownerEpoch: EPOCH + 1 };
    rx.bindSession(binding(next));
    fail(msg(2, "skip", 1, RUN, next.ownerEpoch), "resync-required", next);
    ack(msg(1, "new", 0, RUN, next.ownerEpoch), 1, next);
    fail(msg(2, "late", 1), "epoch-mismatch", rotated);
    ack(msg(2, "current", 1, RUN, next.ownerEpoch), 2, next);
    expect(deltas()).toEqual(["first", "second", "new", "current"]);
  });

  it("ACKs before buffered failure", () => {
    const first = msg(1, "first", 0, "run-prefix");
    const second = msg(2, "second", 0, "run-buffered");
    claimAgentRunContext(second.runId, { sessionKey: KEY });
    ack(second, 0);
    ack(first);
    fail(second, "invalid-event");
    clearAgentRunContext(second.runId);
    ack(second);
    expect(deltas()).toEqual(["first", "second"]);
  });

  it("retains a buffered capacity tail until the active run releases", () => {
    start({ maxActiveRuns: 1 });
    const first = msg(1, "first", 0, "run-prefix");
    const second = msg(2, "second", 0, "run-buffered");
    const retry = msg(2, "replacement", 1, second.runId);
    const terminal = {
      ...live(3, lifecycle({ phase: "end", endedAt: 200 }), first.runId),
      lastAckedSeq: 1,
    };

    ack(second, 0);
    ack(first);
    expect(getAgentRunContext(first.runId)).toBeDefined();
    expect(getAgentRunContext(second.runId)).toBeUndefined();
    expect(events.map((event) => event.runId)).toEqual([first.runId]);

    ack(retry, 1);
    expect(getAgentRunContext(first.runId)).toBeDefined();
    expect(events.map((event) => event.runId)).toEqual([first.runId]);

    ack(terminal, 1);
    expect(getAgentRunContext(first.runId)).toBeDefined();
    expect(getAgentRunContext(second.runId)).toBeUndefined();
    expect(events.map((event) => event.runId)).toEqual([first.runId]);

    ack(retry, 3);
    ack(terminal, 3);
    expect(events.map((event) => [event.runId, event.stream])).toEqual([
      [first.runId, "assistant"],
      [second.runId, "assistant"],
      [first.runId, "lifecycle"],
    ]);
    expect(deltas()).toEqual(["first", "second", undefined]);
  });

  it("does not borrow capacity past another new run", () => {
    start({ maxActiveRuns: 1 });
    const first = msg(1, "first", 0, "run-prefix");
    const second = msg(2, "second", 0, "run-buffered");
    const third = msg(3, "third", 0, "run-intervening");
    const terminal = {
      ...live(4, lifecycle({ phase: "end", endedAt: 200 }), first.runId),
      lastAckedSeq: 0,
    };

    ack(second, 0);
    ack(third, 0);
    ack(terminal, 0);
    ack(first);
    ack(msg(2, "replacement", 1, second.runId), 1);

    expect(events.map((event) => event.runId)).toEqual([first.runId]);
    expect(getAgentRunContext(second.runId)).toBeUndefined();
    expect(getAgentRunContext(third.runId)).toBeUndefined();
  });

  it("bounds a retained capacity tail with normal resync", () => {
    const first = msg(1, "first", 0, "run-prefix");
    const second = msg(2, "second", 0, "run-buffered");
    start({
      maxActiveRuns: 1,
      maxPendingBytes: Buffer.byteLength(JSON.stringify(second.event), "utf8"),
    });

    ack(second, 0);
    ack(first);
    expect(
      rx.apply({
        identity: ID,
        request: msg(3, "overflow", 1, "run-overflow"),
      }),
    ).toEqual({
      ok: false,
      details: { reason: "resync-required", ackedSeq: 1, expectedSeq: 2 },
    });

    fail(msg(2, "blocked", 1, second.runId), "capacity-exceeded");
    fail(msg(2, "stale", 1, second.runId), "resync-required");
    ack(msg(1, "fresh", 0, second.runId));
    expect(deltas()).toEqual(["first", "fresh"]);
  });

  it("clears speculative pending events on in-window resync", () => {
    start({ windowSize: 2 });
    ack(msg(2, "stale"), 0);
    fail(msg(3, "gap"), "resync-required");

    ack(msg(1, "first"));
    ack(msg(2, "fresh", 1));

    expect(deltas()).toEqual(["first", "fresh"]);
  });

  it("resets after capacity failure", () => {
    start({ maxActiveRuns: 1 });
    ack(msg(1, "active", 0, "run-active"));
    fail(msg(2, "overlap", 1, "run-overlap"), "capacity-exceeded");
    fail(msg(2, "stale", 1, "run-overlap"), "resync-required");
    ack(msg(1, "fresh", 0, "run-overlap"));
  });

  it("does not reserve a pending terminal for an unbuffered head", () => {
    start({ maxActiveRuns: 1 });
    const activeRunId = "run-active";
    ack(msg(1, "active", 0, activeRunId));
    ack(
      {
        ...live(3, lifecycle({ phase: "end", endedAt: 200 }), activeRunId),
        lastAckedSeq: 1,
      },
      1,
    );
    fail(msg(2, "overlap", 1, "run-overlap"), "capacity-exceeded");
    fail(msg(2, "stale", 1, "run-overlap"), "resync-required");
    ack(msg(1, "fresh", 0, "run-overlap"));
  });

  it.each([RUN, "run-sibling"])("resyncs after a swept context before %s", (runId) => {
    ack(msg(1, "before"));
    expect(sweepStaleRunContexts(-1)).toBe(1);
    fail(msg(2, "stale", 1, runId), "resync-required");
    ack(msg(1, "fresh", 0, runId));
    expect(deltas()).toEqual(["before", "fresh"]);
  });

  it("survives config suspension", () => {
    const valid = cfg;
    ack(msg(1, "before"));
    ack(msg(3, "third", 1), 1);
    cfg = {
      ...cfg,
      session: { ...cfg.session, store: path.join(root, "missing", "{agentId}", "sessions.json") },
    };
    rx.rebindAll(cfg);
    fail(msg(2, "suspended", 1), "session-not-attached");
    cfg = valid;
    rx.rebindAll(cfg);
    ack(msg(2, "after", 1), 3);
    expect(deltas()).toEqual(["before", "after", "third"]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("moves without losing state", async () => {
    const moved = `${KEY}-moved`;
    ack(msg(1, "first"));
    ack(msg(3, "third", 1), 1);
    await sessions.patchSessionEntryTarget(
      { agentId: "main", storePath: store, target: { canonicalKey: moved, storeKeys: [KEY] } },
      () => ({ updatedAt: 20 }),
    );
    ack(msg(2, "second", 1), 3);
    expect(getAgentRunContext(RUN)?.sessionKey).toBe(moved);
  });

  it("fences a committed reset", async () => {
    ack(msg(1, "before"));
    await sessions.resetSessionEntryLifecycle({
      agentId: "main",
      buildNextEntry: () => ({ sessionId: `${SID}-replacement`, updatedAt: 20 }),
      storePath: store,
      target,
    });
    fail(msg(2, "after", 1), "session-not-attached");
  });

  it("restarts after deletion", async () => {
    ack(msg(1, "before"));
    ack(msg(3, "buffered", 1), 1);
    await remove();
    fail(msg(2, "after", 1), "session-not-attached");
    await create(30);
    ack(msg(1, "fresh"));
    expect(deltas()).toEqual(["before", "fresh"]);
  });

  it("fences terminal runs", () => {
    ack(
      live(1, { kind: "lifecycle", payload: { phase: "error", endedAt: 100, error: "retryable" } }),
    );
    ack(msg(2, "recovered", 1));
    const end = events[0];
    clearAgentRunContext(RUN, end?.lifecycleGeneration, end?.contextClaimId);
    fail(msg(3, "released", 2), "invalid-event");

    start({ windowSize: 2 });
    ack(live(1, { kind: "lifecycle", payload: { phase: "end", endedAt: 200 } }));
    ack(msg(2, "other", 1, "run-other"));
    fail(msg(3, "late", 2), "invalid-event");
  });

  it("retains a terminal fence while its run remains claimed", () => {
    start({ windowSize: 2 });
    ack(live(1, { kind: "lifecycle", payload: { phase: "end", endedAt: 200 } }));
    ack(msg(2, "other-first", 1, "run-other"));
    ack(msg(3, "other-second", 2, "run-other"));

    fail(msg(4, "late", 3), "invalid-event");
    expect(events.filter((event) => event.runId === RUN)).toHaveLength(1);
  });

  it("clears on detach", () => {
    ack(msg(1, "delivered"));
    ack(msg(3, "buffered", 1), 1);
    rx.clearEnvironment(ID.environmentId);
    expect(getAgentRunContext(RUN)).toBeUndefined();
    fail(msg(1, "pending", 0, "run-pending"), "invalid-event");
  });

  it("adopts a compatible pre-registered gateway run context", () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    claimAgentRunContext(RUN, {
      ...LOCAL,
      isControlUiVisible: false,
      lifecycleGeneration,
    });

    ack(msg(1, "worker"));

    expect(getAgentRunContext(RUN)).toMatchObject({
      ...LOCAL,
      isControlUiVisible: false,
      lifecycleGeneration,
      projectSessionActive: true,
    });
    expect(deltas()).toEqual(["worker"]);
  });

  it("adopts a visible dispatch-owned run context so worker live events stay visible", () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    // A worker-routed turn keeps its dispatch-owned Control UI visibility. The
    // gateway claims the run context (isControlUiVisible: true for a visible
    // turn) before handing the turn to the remote worker; adopting live events
    // must inherit that visibility instead of forcing the run hidden.
    claimAgentRunContext(RUN, {
      ...LOCAL,
      isControlUiVisible: true,
      lifecycleGeneration,
    });

    ack(msg(1, "worker"));

    expect(getAgentRunContext(RUN)).toMatchObject({
      ...LOCAL,
      isControlUiVisible: true,
      lifecycleGeneration,
      projectSessionActive: true,
    });
    expect(deltas()).toEqual(["worker"]);
    expect(events[0]?.controlUiVisible).toBe(true);
  });

  it("rejects pre-registered gateway run contexts with mismatched identity", () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const mismatches: Array<{
      context: Parameters<typeof claimAgentRunContext>[1];
      name: string;
    }> = [
      { name: "session-id", context: { ...LOCAL, sessionId: `${SID}-other` } },
      { name: "session-key", context: { ...LOCAL, sessionKey: `${KEY}-other` } },
      { name: "agent-id", context: { ...LOCAL, agentId: "other" } },
      { name: "lifecycle", context: { ...LOCAL, lifecycleGeneration: "other-lifecycle" } },
    ];

    for (const mismatch of mismatches) {
      const runId = `run-mismatch-${mismatch.name}`;
      claimAgentRunContext(runId, {
        isControlUiVisible: false,
        lifecycleGeneration,
        ...mismatch.context,
      });
      fail(msg(1, "blocked", 0, runId), "invalid-event");
      clearAgentRunContext(runId);
    }
    expect(events).toEqual([]);
  });

  it("keeps a claimed run id exclusive against a later untracked local claim", () => {
    const worker = "run-worker-first";
    ack(msg(1, "worker", 0, worker));
    // A same-identity untracked claim cannot hijack a run live events already own.
    claimAgentRunContext(worker, LOCAL);
    clearAgentRunContext(worker);
    emitAgentEvent({
      runId: worker,
      stream: "assistant",
      data: { text: "local", delta: "local" },
    });
    ack(msg(2, "again", 1, worker));
    expect(deltas()).toEqual(["worker", "again"]);
  });
});
