import { beforeEach, describe, expect, test, vi } from "vitest";
import { createAgentExecutionAttribution } from "../agents/agent-execution-attribution.js";
import {
  type AgentEventPayload,
  emitAgentAuditEvent,
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentAuditEvent,
  onAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "./agent-events.js";
import { onAgentRunContextRetired } from "./agent-run-context-retirement.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  sweepStaleRunContexts,
} from "./agent-run-registry.js";

describe("agent event execution attribution", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  test("keeps the first same-generation attribution private and immutable", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-ctx",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      agentId: "main",
    });
    const replacement = createAgentExecutionAttribution({
      runId: "run-ctx",
      lifecycleGeneration: attribution.lifecycleGeneration,
      sessionKey: "agent:main:other",
      sessionId: "session-2",
      agentId: "main",
    });
    registerAgentRunContext("run-ctx", {
      attribution,
      lifecycleGeneration: attribution.lifecycleGeneration,
    });
    registerAgentRunContext("run-ctx", {
      attribution: replacement,
      lifecycleGeneration: attribution.lifecycleGeneration,
      verboseLevel: "full",
    });

    expect(getAgentRunContext("run-ctx")?.attribution).toBe(attribution);
    expect(getAgentRunContext("run-ctx")?.verboseLevel).toBe("full");
    expect(Reflect.set(getAgentRunContext("run-ctx")!, "attribution", replacement)).toBe(false);

    let received: AgentEventPayload | undefined;
    const stop = onAgentEvent((event) => {
      received = event;
    });
    emitAgentEvent({ runId: "run-ctx", stream: "lifecycle", data: { phase: "end" } });
    stop();

    expect(JSON.stringify(received)).not.toContain("attribution");
  });

  test("projects admission attribution only onto private audit events", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-audit-attribution",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionKey: "agent:main:admitted",
      sessionId: "session-admitted",
      agentId: "main",
    });
    registerAgentRunContext(attribution.runId, {
      attribution,
      lifecycleGeneration: attribution.lifecycleGeneration,
    });
    let received: AgentEventPayload | undefined;
    const stop = onAgentAuditEvent((event) => {
      received = event;
    });

    emitAgentAuditEvent({
      runId: attribution.runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
      sessionKey: "agent:forged:event",
      sessionId: "session-forged",
      agentId: "forged",
    });
    stop();

    expect(received).toMatchObject({
      runId: attribution.runId,
      sessionKey: attribution.sessionKey,
      sessionId: attribution.sessionId,
      agentId: attribution.agentId,
    });
    expect(received?.lifecycleGeneration).toBe(getAgentEventLifecycleGeneration());
    expect(received).not.toHaveProperty("attribution");
    expect(JSON.stringify(received)).not.toContain("lifecycleGeneration");
  });

  test("does not erase context provenance when admission attribution is sparse", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-sparse-attribution",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    registerAgentRunContext(attribution.runId, {
      attribution,
      lifecycleGeneration: attribution.lifecycleGeneration,
      sessionKey: "agent:main:context",
      sessionId: "session-context",
      agentId: "main",
    });
    let received: AgentEventPayload | undefined;
    const stop = onAgentAuditEvent((event) => {
      received = event;
    });

    emitAgentAuditEvent({
      runId: attribution.runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    stop();

    expect(received).toMatchObject({
      sessionKey: "agent:main:context",
      sessionId: "session-context",
      agentId: "main",
    });
  });

  test("does not project attribution across lifecycle generations", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-stale-attribution",
      lifecycleGeneration: "generation-old",
      sessionKey: "agent:main:admitted",
      sessionId: "session-admitted",
      agentId: "main",
    });
    registerAgentRunContext(attribution.runId, {
      attribution,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    let received: AgentEventPayload | undefined;
    const stop = onAgentAuditEvent((event) => {
      received = event;
    });

    emitAgentAuditEvent({
      runId: attribution.runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
      sessionKey: "agent:new:event",
      sessionId: "session-new",
      agentId: "new",
    });
    stop();

    expect(received).toMatchObject({
      runId: attribution.runId,
      sessionKey: "agent:new:event",
      sessionId: "session-new",
      agentId: "new",
    });
  });

  test("owns context-free audit lifecycle events until terminal notification", () => {
    const observedContexts: Array<string | undefined> = [];
    const stop = onAgentAuditEvent((event) => {
      if (event.runId === "synthetic-audit-run") {
        observedContexts.push(getAgentRunContext(event.runId)?.sessionKey);
      }
    });

    emitAgentAuditEvent({
      runId: "synthetic-audit-run",
      sessionKey: "agent:main:acp:session",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    expect(getAgentRunContext("synthetic-audit-run")).toMatchObject({
      sessionKey: "agent:main:acp:session",
    });
    emitAgentAuditEvent({
      runId: "synthetic-audit-run",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    stop();

    expect(observedContexts).toEqual(["agent:main:acp:session", "agent:main:acp:session"]);
    expect(getAgentRunContext("synthetic-audit-run")).toBeUndefined();
  });

  test("owns context-free shared lifecycle events until terminal notification", () => {
    const observedContexts: Array<string | undefined> = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "synthetic-shared-run") {
        observedContexts.push(getAgentRunContext(event.runId)?.sessionKey);
      }
    });

    emitAgentEvent({
      runId: "synthetic-shared-run",
      sessionKey: "agent:plugin:main",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    expect(getAgentRunContext("synthetic-shared-run")).toMatchObject({
      sessionKey: "agent:plugin:main",
    });
    emitAgentEvent({
      runId: "synthetic-shared-run",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    stop();

    expect(observedContexts).toEqual(["agent:plugin:main", "agent:plugin:main"]);
    expect(getAgentRunContext("synthetic-shared-run")).toBeUndefined();
  });

  test("retires context-free lifecycle ownership at gateway rotation", () => {
    emitAgentAuditEvent({
      runId: "synthetic-rotated-run",
      sessionKey: "agent:main:acp:session",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    expect(getAgentRunContext("synthetic-rotated-run")).toBeDefined();

    rotateAgentEventLifecycleGeneration();

    expect(getAgentRunContext("synthetic-rotated-run")).toBeUndefined();
  });

  test("keeps synthetic lifecycle ownership live until terminal cleanup", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    emitAgentAuditEvent({
      runId: "synthetic-long-run",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });

    clock.mockReturnValue(1_000);
    expect(sweepStaleRunContexts(500)).toBe(0);
    expect(getAgentRunContext("synthetic-long-run")).toBeDefined();

    emitAgentAuditEvent({
      runId: "synthetic-long-run",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    expect(getAgentRunContext("synthetic-long-run")).toBeUndefined();
    clock.mockRestore();
  });

  test("bounds abandoned synthetic lifecycle ownership", () => {
    for (let index = 0; index < 4_097; index += 1) {
      emitAgentEvent({
        runId: `synthetic-abandoned-${index}`,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
    }

    expect(getAgentRunContext("synthetic-abandoned-0")).toBeUndefined();
    expect(getAgentRunContext("synthetic-abandoned-4096")).toBeDefined();
  });

  test("delivers an owned pre-rotation retry only to the private audit bus", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-stale-audit-retry",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionKey: "agent:main:admitted",
      sessionId: "session-admitted",
      agentId: "main",
    });
    registerAgentRunContext(attribution.runId, {
      attribution,
      lifecycleGeneration: attribution.lifecycleGeneration,
    });
    const audit: AgentEventPayload[] = [];
    const shared: AgentEventPayload[] = [];
    const stopAudit = onAgentAuditEvent((event) => audit.push(event));
    const stopShared = onAgentEvent((event) => shared.push(event));

    withAgentRunLifecycleGeneration(attribution.lifecycleGeneration, () => {
      emitAgentAuditEvent({
        runId: attribution.runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
    });
    rotateAgentEventLifecycleGeneration();
    withAgentRunLifecycleGeneration(attribution.lifecycleGeneration, () => {
      emitAgentAuditEvent({
        runId: attribution.runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
    });
    stopAudit();
    stopShared();

    expect(shared).toEqual([]);
    expect(audit.map((event) => event.seq)).toEqual([1, 2]);
    expect(audit[1]).toMatchObject({
      runId: attribution.runId,
      sessionKey: attribution.sessionKey,
      sessionId: attribution.sessionId,
      agentId: attribution.agentId,
    });
    expect(audit[1]?.lifecycleGeneration).toBe(attribution.lifecycleGeneration);
  });

  test("continues audit sequencing after context cleanup and lifecycle rotation", () => {
    const runId = "run-delayed-audit-terminal";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    const audit: AgentEventPayload[] = [];
    const stop = onAgentAuditEvent((event) => audit.push(event));

    withAgentRunLifecycleGeneration(lifecycleGeneration, () => {
      emitAgentAuditEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
    });
    clearAgentRunContext(runId, lifecycleGeneration);
    rotateAgentEventLifecycleGeneration();
    withAgentRunLifecycleGeneration(lifecycleGeneration, () => {
      emitAgentAuditEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "end" },
      });
    });
    stop();

    expect(audit.map((event) => event.seq)).toEqual([1, 2]);
  });

  test("continues audit sequencing after same-generation context cleanup", () => {
    const runId = "run-same-generation-delayed-terminal";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    const audit: AgentEventPayload[] = [];
    const stop = onAgentAuditEvent((event) => audit.push(event));

    withAgentRunLifecycleGeneration(lifecycleGeneration, () => {
      emitAgentAuditEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
    });
    clearAgentRunContext(runId, lifecycleGeneration);
    withAgentRunLifecycleGeneration(lifecycleGeneration, () => {
      emitAgentAuditEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "end" },
      });
    });
    stop();

    expect(audit.map((event) => event.seq)).toEqual([1, 2]);
  });

  test("preserves retired sequencing across a second same-generation cleanup", () => {
    const runId = "run-same-generation-rebound-delayed-terminal";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:first:main",
      agentId: "first",
    });
    const audit: AgentEventPayload[] = [];
    const stop = onAgentAuditEvent((event) => audit.push(event));

    withAgentRunLifecycleGeneration(lifecycleGeneration, () => {
      emitAgentAuditEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
    });
    clearAgentRunContext(runId, lifecycleGeneration);
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      sessionKey: "agent:second:main",
      agentId: "second",
    });
    withAgentRunLifecycleGeneration(lifecycleGeneration, () => {
      emitAgentAuditEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 2_000 },
      });
    });
    clearAgentRunContext(runId, lifecycleGeneration);
    withAgentRunLifecycleGeneration(lifecycleGeneration, () => {
      emitAgentAuditEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "end" },
      });
    });
    stop();

    expect(audit.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  test("delivers an old-generation terminal after the run id is rebound", () => {
    const runId = "run-rebound-before-terminal";
    const oldGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration: oldGeneration,
      sessionKey: "agent:old:main",
      agentId: "old",
    });
    const audit: AgentEventPayload[] = [];
    const stop = onAgentAuditEvent((event) => audit.push(event));

    withAgentRunLifecycleGeneration(oldGeneration, () => {
      emitAgentAuditEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
    });
    const newGeneration = rotateAgentEventLifecycleGeneration();
    claimAgentRunContext(runId, {
      lifecycleGeneration: newGeneration,
      sessionKey: "agent:new:main",
      agentId: "new",
    });
    withAgentRunLifecycleGeneration(oldGeneration, () => {
      emitAgentAuditEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "end" },
      });
    });
    stop();

    expect(audit.map((event) => event.seq)).toEqual([1, 2]);
    expect(audit[1]?.lifecycleGeneration).toBe(oldGeneration);
  });

  test("notifies internal projections when run contexts retire", () => {
    const retired: Array<{
      runId: string;
      lifecycleGeneration: string;
      reason: string;
    }> = [];
    const unsubscribe = onAgentRunContextRetired((event) => {
      retired.push({
        runId: event.runId,
        lifecycleGeneration: event.lifecycleGeneration,
        reason: event.reason,
      });
    });
    const firstGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("run-replaced", {
      sessionKey: "session-first",
      lifecycleGeneration: firstGeneration,
    });

    const secondGeneration = rotateAgentEventLifecycleGeneration();
    claimAgentRunContext("run-replaced", {
      sessionKey: "session-second",
      lifecycleGeneration: secondGeneration,
    });
    clearAgentRunContext("run-replaced", secondGeneration);

    expect(retired).toEqual([
      { runId: "run-replaced", lifecycleGeneration: firstGeneration, reason: "replaced" },
      { runId: "run-replaced", lifecycleGeneration: secondGeneration, reason: "cleared" },
    ]);
    unsubscribe();
  });
});
