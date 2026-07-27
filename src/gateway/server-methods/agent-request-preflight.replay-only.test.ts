import { afterEach, describe, expect, it, vi } from "vitest";
import type { DedupeEntry } from "../server-shared.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { agentJobTesting, setGatewayDedupeEntry } from "./agent-job.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";

function prepareReplayOnly(
  dedupe: Map<string, DedupeEntry>,
  replayCapability: string | null = "test-capability-placeholder",
  runId = "run-recovery",
) {
  const respond = vi.fn();
  const getRuntimeConfig = vi.fn(() => ({}));
  const prepared = prepareAgentRequestPreflight({
    params: {
      message: "recover this run",
      idempotencyKey: runId,
      replayOnly: true,
      ...(replayCapability ? { replayCapability } : {}),
    },
    respond,
    context: {
      dedupe,
      getRuntimeConfig,
    },
    client: undefined,
  } as unknown as Parameters<typeof prepareAgentRequestPreflight>[0]);
  return { getRuntimeConfig, prepared, respond };
}

afterEach(() => {
  agentJobTesting.resetRecoveryCacheForTests();
});

function prepareOrdinary(dedupe: Map<string, DedupeEntry>, replayCapability?: string) {
  const respond = vi.fn();
  const getRuntimeConfig = vi.fn(() => ({}));
  const prepared = prepareAgentRequestPreflight({
    params: {
      message: "retry this run",
      idempotencyKey: "run-recovery",
      ...(replayCapability ? { replayCapability } : {}),
    },
    respond,
    context: {
      dedupe,
      getRuntimeConfig,
    },
    client: undefined,
  } as unknown as Parameters<typeof prepareAgentRequestPreflight>[0]);
  return { getRuntimeConfig, prepared, respond };
}

describe("agent replay-only preflight", () => {
  it("returns the exact cached terminal response", () => {
    const payload = {
      runId: "run-recovery",
      status: "ok",
      result: { payloads: [{ text: "original result" }] },
    };
    const { prepared, respond } = prepareReplayOnly(
      new Map([
        [
          "agent:run-recovery",
          {
            ts: Date.now(),
            ok: true,
            agentReplayCapability: "test-capability-placeholder",
            payload,
          },
        ],
      ]),
    );

    expect(prepared).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(true, payload, undefined, { cached: true });
  });

  it("requires the recovery capability before replaying an accepted run", () => {
    const runId = "accepted-recovery";
    const dedupe = new Map<string, DedupeEntry>([
      [
        `agent:${runId}`,
        {
          ts: Date.now(),
          ok: true,
          agentReplayCapability: "test-capability-placeholder",
          payload: { runId, status: "accepted", sessionKey: "agent:main:incident-42" },
        },
      ],
    ]);

    const accepted = prepareReplayOnly(dedupe, "test-capability-placeholder", runId);
    expect(accepted.prepared).toBeUndefined();
    expect(accepted.respond).toHaveBeenCalledWith(
      true,
      {
        runId,
        status: "in_flight",
        sessionKey: "agent:main:incident-42",
      },
      undefined,
      { cached: true, runId },
    );

    for (const replayCapability of ["wrong-capability", null]) {
      const rejected = prepareReplayOnly(dedupe, replayCapability, runId);
      expect(rejected.prepared).toBeUndefined();
      expect(rejected.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
    }
  });

  it("marks cached terminal failures separately from replay request failures", () => {
    const payload = {
      runId: "run-recovery",
      status: "error",
      summary: "original provider failure",
    };
    const { prepared, respond } = prepareReplayOnly(
      new Map([
        [
          "agent:run-recovery",
          {
            ts: Date.now(),
            ok: false,
            agentReplayCapability: "test-capability-placeholder",
            payload,
            error: {
              code: "UNAVAILABLE",
              message: "original provider failure",
              details: { provider: "mock" },
            },
          },
        ],
      ]),
    );

    expect(prepared).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      payload,
      {
        code: "UNAVAILABLE",
        message: "original provider failure",
        details: {
          code: "CACHED_AGENT_RESULT",
          runId: "run-recovery",
          originalDetails: { provider: "mock" },
        },
      },
      { cached: true },
    );
  });

  it("marks an aliased cached failure with its canonical run id", () => {
    const { prepared, respond } = prepareReplayOnly(
      new Map([
        [
          "agent:run-recovery",
          {
            ts: Date.now(),
            ok: false,
            agentReplayCapability: "test-capability-placeholder",
            payload: { runId: "canonical-run", status: "error" },
            error: { code: "UNAVAILABLE", message: "original provider failure" },
          },
        ],
      ]),
    );

    expect(prepared).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      { runId: "canonical-run", status: "error" },
      expect.objectContaining({
        details: expect.objectContaining({
          code: "CACHED_AGENT_RESULT",
          runId: "canonical-run",
          requestedRunId: "run-recovery",
        }),
      }),
      { cached: true },
    );
  });

  it("fails closed on a cache miss without admitting a new run", () => {
    const { getRuntimeConfig, prepared, respond } = prepareReplayOnly(new Map());

    expect(prepared).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      { runId: "run-recovery", status: "unavailable" },
      expect.objectContaining({
        code: "AGENT_RESULT_NOT_FOUND",
        message: expect.stringContaining("did not start a new run"),
      }),
      { runId: "run-recovery" },
    );
    expect(getRuntimeConfig).not.toHaveBeenCalled();
  });

  it("replays a terminal result after the short dedupe entry has expired", () => {
    const runId = "run-recovery-after-dedupe-expiry";
    const payload = {
      runId,
      status: "ok",
      result: { payloads: [{ text: "original result" }] },
    };
    const dedupe = new Map<string, DedupeEntry>();
    setGatewayDedupeEntry({
      dedupe,
      key: `agent:${runId}`,
      entry: {
        ts: Date.now(),
        ok: true,
        agentReplayCapability: "test-capability-placeholder",
        payload,
      },
    });
    dedupe.clear();

    const { prepared, respond } = prepareReplayOnly(dedupe, "test-capability-placeholder", runId);

    expect(prepared).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(true, payload, undefined, { cached: true });

    const forbidden = prepareReplayOnly(dedupe, "wrong-capability", runId);
    expect(forbidden.prepared).toBeUndefined();
    expect(forbidden.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("does not retain an accepted reservation after the live dedupe entry is cleared", () => {
    const runId = "accepted-reservation";
    const dedupe = new Map<string, DedupeEntry>();
    setGatewayDedupeEntry({
      dedupe,
      key: `agent:${runId}`,
      entry: {
        ts: Date.now(),
        ok: true,
        agentReplayCapability: "test-capability-placeholder",
        payload: { runId, status: "accepted" },
      },
    });
    dedupe.clear();

    const { prepared, respond } = prepareReplayOnly(dedupe, "test-capability-placeholder", runId);

    expect(prepared).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      { runId, status: "unavailable" },
      expect.objectContaining({ code: "AGENT_RESULT_NOT_FOUND" }),
      { runId },
    );
  });

  it("bounds retained terminal recovery results by byte budget", () => {
    agentJobTesting.setRecoveryCacheLimitsForTests({ maxEntries: 2, maxBytes: 512 });
    const dedupe = new Map<string, DedupeEntry>();
    const firstRunId = "run-recovery-budget-first";
    const secondRunId = "run-recovery-budget-second";
    const entry = (runId: string) => ({
      ts: Date.now(),
      ok: true,
      agentReplayCapability: "test-capability-placeholder",
      payload: {
        runId,
        status: "ok",
        result: { payloads: [{ text: "x".repeat(160) }] },
      },
    });
    setGatewayDedupeEntry({ dedupe, key: `agent:${firstRunId}`, entry: entry(firstRunId) });
    setGatewayDedupeEntry({ dedupe, key: `agent:${secondRunId}`, entry: entry(secondRunId) });
    dedupe.clear();

    const evicted = prepareReplayOnly(dedupe, "test-capability-placeholder", firstRunId);
    expect(evicted.prepared).toBeUndefined();
    expect(evicted.respond).toHaveBeenCalledWith(
      false,
      { runId: firstRunId, status: "unavailable" },
      expect.objectContaining({ code: "AGENT_RESULT_NOT_FOUND" }),
      { runId: firstRunId },
    );

    const retained = prepareReplayOnly(dedupe, "test-capability-placeholder", secondRunId);
    expect(retained.prepared).toBeUndefined();
    expect(retained.respond).toHaveBeenCalledWith(true, entry(secondRunId).payload, undefined, {
      cached: true,
    });
  });

  it("keeps the authoritative recovery result when a weaker terminal arrives late", () => {
    const runId = "run-recovery-terminal-precedence";
    const dedupe = new Map<string, DedupeEntry>();
    const timeoutEntry = {
      ts: 1,
      ok: true,
      agentReplayCapability: "authoritative-capability",
      payload: {
        runId,
        status: "timeout",
        endedAt: 200,
        timeoutPhase: "provider",
        providerStarted: true,
      },
    } satisfies DedupeEntry;
    setGatewayDedupeEntry({ dedupe, key: `agent:${runId}`, entry: timeoutEntry });
    dedupe.clear();
    setGatewayDedupeEntry({
      dedupe,
      key: `agent:${runId}`,
      entry: {
        ts: 2,
        ok: true,
        agentReplayCapability: "late-capability",
        payload: { runId, status: "ok", endedAt: 300 },
      },
    });
    expect(dedupe.has(`agent:${runId}`)).toBe(false);

    const replayed = prepareReplayOnly(dedupe, "authoritative-capability", runId);
    expect(replayed.prepared).toBeUndefined();
    expect(replayed.respond).toHaveBeenCalledWith(true, timeoutEntry.payload, undefined, {
      cached: true,
    });

    const rejected = prepareReplayOnly(dedupe, "late-capability", runId);
    expect(rejected.prepared).toBeUndefined();
    expect(rejected.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("uses the terminal run token instead of the mutable cache entry token", () => {
    const dedupe = new Map<string, DedupeEntry>([
      [
        "agent:run-recovery",
        {
          ts: 1,
          ok: true,
          agentReplayCapability: "newer-run-capability",
          payload: { runId: "run-recovery", status: "accepted" },
        },
      ],
    ]);
    setGatewayDedupeEntries({
      dedupe,
      keys: ["agent:run-recovery"],
      entry: {
        ts: 2,
        ok: true,
        agentReplayCapability: "test-capability-placeholder",
        payload: { runId: "run-recovery", status: "ok" },
      },
    });

    const { prepared, respond } = prepareReplayOnly(dedupe);

    expect(prepared).toBeUndefined();
    expect(dedupe.get("agent:run-recovery")?.agentReplayCapability).toBe(
      "test-capability-placeholder",
    );
    expect(respond).toHaveBeenCalledWith(true, { runId: "run-recovery", status: "ok" }, undefined, {
      cached: true,
    });
  });

  it("rejects a cached result requested with the wrong replay token", () => {
    const payload = { runId: "run-recovery", status: "ok" };
    const { getRuntimeConfig, prepared, respond } = prepareReplayOnly(
      new Map([
        [
          "agent:run-recovery",
          {
            ts: Date.now(),
            ok: true,
            agentReplayCapability: "test-capability-placeholder",
            payload,
          },
        ],
      ]),
      "fake",
    );

    expect(prepared).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(getRuntimeConfig).not.toHaveBeenCalled();
  });

  it("requires the recovery token on ordinary cache hits for protected runs", () => {
    const payload = { runId: "run-recovery", status: "ok" };
    const dedupe = new Map<string, DedupeEntry>([
      [
        "agent:run-recovery",
        {
          ts: Date.now(),
          ok: true,
          agentReplayCapability: "test-capability-placeholder",
          payload,
        },
      ],
    ]);

    const rejected = prepareOrdinary(dedupe);
    expect(rejected.prepared).toBeUndefined();
    expect(rejected.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );

    const accepted = prepareOrdinary(dedupe, "test-capability-placeholder");
    expect(accepted.prepared).toBeUndefined();
    expect(accepted.respond).toHaveBeenCalledWith(true, payload, undefined, { cached: true });
  });

  it("retains ordinary dedupe compatibility for legacy unprotected runs", () => {
    const payload = { runId: "run-recovery", status: "ok" };
    const { prepared, respond } = prepareOrdinary(
      new Map([["agent:run-recovery", { ts: Date.now(), ok: true, payload }]]),
    );

    expect(prepared).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(true, payload, undefined, { cached: true });
  });
});
