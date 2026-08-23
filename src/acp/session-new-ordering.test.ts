import type { AnyMessage } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { AcpSessionNewOrdering } from "./session-new-ordering.js";

type Step = { inbound: AnyMessage } | { outbound: AnyMessage };

/**
 * Drives a script through the ordering boundary. Inbound steps are observed the way
 * `serveAcpGateway` observes them — synchronously, before dispatch — so a test can
 * interleave client traffic with agent output and see the resulting wire order.
 */
async function runSteps(ordering: AcpSessionNewOrdering, steps: Step[]): Promise<AnyMessage[]> {
  const stream = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      ordering.transformOutbound(message, controller);
    },
  });
  const outputPromise = (async () => {
    const reader = stream.readable.getReader();
    const output: AnyMessage[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return output;
      }
      output.push(value);
    }
  })();
  const writer = stream.writable.getWriter();
  for (const step of steps) {
    if ("inbound" in step) {
      ordering.observeInbound(step.inbound);
      continue;
    }
    await writer.write(step.outbound);
  }
  await writer.close();
  return outputPromise;
}

function newSessionRequest(id: number): AnyMessage {
  return { jsonrpc: "2.0", id, method: "session/new", params: { cwd: "/tmp" } } as AnyMessage;
}

function newSessionResponse(id: number, sessionId: string): AnyMessage {
  return { jsonrpc: "2.0", id, result: { sessionId } } as AnyMessage;
}

function sessionUpdate(sessionId: string, title = "Session"): AnyMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "session_info_update", title } },
  } as AnyMessage;
}

describe("AcpSessionNewOrdering", () => {
  it("emits a new-session result before updates that reference its session ID", async () => {
    const ordering = new AcpSessionNewOrdering();
    const update = sessionUpdate("new-session", "New session");
    const result = newSessionResponse(2, "new-session");

    await expect(
      runSteps(ordering, [
        { inbound: newSessionRequest(2) },
        { outbound: update },
        { outbound: result },
      ]),
    ).resolves.toEqual([result, update]);
  });

  it("does not delay updates for a session ID supplied by the client", async () => {
    const ordering = new AcpSessionNewOrdering();
    const update = sessionUpdate("existing-session", "Existing session");

    await expect(
      runSteps(ordering, [
        {
          inbound: {
            jsonrpc: "2.0",
            id: 3,
            method: "session/load",
            params: { sessionId: "existing-session", cwd: "/tmp" },
          } as AnyMessage,
        },
        { outbound: update },
      ]),
    ).resolves.toEqual([update]);
  });

  it("treats a resumed session as established", async () => {
    const ordering = new AcpSessionNewOrdering();
    const update = sessionUpdate("resumed-session");

    await expect(
      runSteps(ordering, [
        {
          inbound: {
            jsonrpc: "2.0",
            id: 4,
            method: "session/resume",
            params: { sessionId: "resumed-session", cwd: "/tmp" },
          } as AnyMessage,
        },
        { outbound: update },
      ]),
    ).resolves.toEqual([update]);
  });

  it("does not establish a session ID named by a request the protocol has not accepted", async () => {
    const ordering = new AcpSessionNewOrdering();
    const prompted = sessionUpdate("never-created");
    const result = newSessionResponse(2, "other-session");

    // `session/prompt` is valid-shaped but the translator rejects an unknown session.
    // Recording it here would let any peer grow the set for the process lifetime.
    // With a `session/new` in flight the difference is observable: an established ID
    // would go straight out, while this one waits for the response.
    await expect(
      runSteps(ordering, [
        {
          inbound: {
            jsonrpc: "2.0",
            id: 5,
            method: "session/prompt",
            params: { sessionId: "never-created", prompt: [] },
          } as AnyMessage,
        },
        { inbound: newSessionRequest(2) },
        { outbound: prompted },
        { outbound: result },
      ]),
    ).resolves.toEqual([result, prompted]);
  });

  it("only establishes a session from the response correlated to its own request", async () => {
    const ordering = new AcpSessionNewOrdering();
    const unrelated = newSessionResponse(99, "other-session");
    const update = sessionUpdate("other-session");

    // Request id 2 is in flight; a result carrying a session ID under a different id
    // is some other call's payload and must not flush this session's updates.
    await expect(
      runSteps(ordering, [
        { inbound: newSessionRequest(2) },
        { outbound: update },
        { outbound: unrelated },
      ]),
    ).resolves.toEqual([unrelated]);
  });

  it("keeps a numeric request ID distinct from the same string ID", async () => {
    const ordering = new AcpSessionNewOrdering();
    const stringIdResponse = { jsonrpc: "2.0", id: "2", result: { sessionId: "s" } } as AnyMessage;

    await expect(
      runSteps(ordering, [
        { inbound: newSessionRequest(2) },
        { outbound: sessionUpdate("s") },
        { outbound: stringIdResponse },
      ]),
    ).resolves.toEqual([stringIdResponse]);
  });

  it("releases buffered updates when the session is closed instead of stranding them", async () => {
    const ordering = new AcpSessionNewOrdering();
    const stranded = sessionUpdate("ghost");
    const later = sessionUpdate("established");

    const output = await runSteps(ordering, [
      { outbound: stranded },
      {
        inbound: {
          jsonrpc: "2.0",
          id: 6,
          method: "session/close",
          params: { sessionId: "ghost" },
        } as AnyMessage,
      },
      {
        inbound: {
          jsonrpc: "2.0",
          id: 7,
          method: "session/load",
          params: { sessionId: "established", cwd: "/tmp" },
        } as AnyMessage,
      },
      { outbound: later },
    ]);

    expect(output).toEqual([stranded, later]);
  });

  it("writes updates through once a session's buffer is full", async () => {
    const ordering = new AcpSessionNewOrdering();
    const buffered = Array.from({ length: 256 }, (_, index) =>
      sessionUpdate("unbounded", `buffered-${index}`),
    );
    const overflow = sessionUpdate("unbounded", "overflow");

    const output = await runSteps(ordering, [
      { inbound: newSessionRequest(1) },
      ...buffered.map((outbound) => ({ outbound })),
      { outbound: overflow },
    ]);

    // Failing open preserves the update; only its ordering degrades to pre-fix behavior.
    expect(output).toEqual([overflow]);
  });

  it("resumes ordering once the saturated correlations drain", async () => {
    const ordering = new AcpSessionNewOrdering();
    const steps: Step[] = [];
    for (let id = 1; id <= 65; id += 1) {
      steps.push({ inbound: newSessionRequest(id) });
    }
    const settled: AnyMessage[] = [];
    for (let id = 1; id <= 64; id += 1) {
      const response = newSessionResponse(id, `s${id}`);
      settled.push(response);
      steps.push({ outbound: response });
    }
    // Correlations are never evicted to make room, so every tracked request still
    // resolves; once they all have, the boundary is provably able to correlate
    // again and buffering resumes.
    const update = sessionUpdate("s100");
    const created = newSessionResponse(100, "s100");
    steps.push({ inbound: newSessionRequest(100) }, { outbound: update }, { outbound: created });

    await expect(runSteps(ordering, steps)).resolves.toEqual([...settled, created, update]);
  });

  it("releases an established session ID when the session closes", async () => {
    const ordering = new AcpSessionNewOrdering();
    const created = newSessionResponse(2, "closing-session");
    const afterClose = sessionUpdate("closing-session", "after close");
    const other = newSessionResponse(3, "other-session");

    const output = await runSteps(ordering, [
      { inbound: newSessionRequest(2) },
      { outbound: created },
      {
        inbound: {
          jsonrpc: "2.0",
          id: 9,
          method: "session/close",
          params: { sessionId: "closing-session" },
        } as AnyMessage,
      },
      { inbound: newSessionRequest(3) },
      { outbound: afterClose },
      { outbound: other },
    ]);

    // The ID was released on close, so a late update is held behind the in-flight
    // response rather than passing straight through as an established session would.
    // Retaining it is what let the set grow for the lifetime of a long-lived bridge.
    expect(output).toEqual([created, other, afterClose]);
  });

  it("fails open instead of buffering once correlation saturates", async () => {
    const ordering = new AcpSessionNewOrdering();
    const steps: Step[] = [];
    for (let id = 1; id <= 65; id += 1) {
      steps.push({ inbound: newSessionRequest(id) });
    }
    const update = sessionUpdate("overflow-session");
    steps.push({ outbound: update });

    const output = await runSteps(ordering, steps);

    // Request 65 could not be correlated, so a response this boundary will not
    // recognize is in flight. Holding an update it cannot prove is releasable is
    // what strands it, so ordering degrades to pre-fix behaviour instead.
    expect(output).toEqual([update]);
  });

  it("does not let an unrelated response stand in for an uncorrelated creation", async () => {
    const ordering = new AcpSessionNewOrdering();
    const steps: Step[] = [];
    for (let id = 1; id <= 65; id += 1) {
      steps.push({ inbound: newSessionRequest(id) });
    }
    // An ordinary RPC response arrives while request 65 is still outstanding. Any
    // fallback that matches a response by count rather than by its own request ID
    // consumes the overflow here, and request 65's own result then no longer
    // establishes its session — the ordering failure, from the other side.
    const unrelated = { jsonrpc: "2.0", id: 900, result: { ok: true } } as AnyMessage;
    const created = newSessionResponse(65, "overflow-session");
    const update = sessionUpdate("overflow-session");
    steps.push({ outbound: unrelated }, { outbound: update }, { outbound: created });

    const output = await runSteps(ordering, steps);

    expect(output).toEqual([unrelated, update, created]);
  });

  it("releases interleaved updates in global arrival order when both creations fail", async () => {
    const ordering = new AcpSessionNewOrdering();
    const a1 = sessionUpdate("session-a", "a1");
    const b1 = sessionUpdate("session-b", "b1");
    const a2 = sessionUpdate("session-a", "a2");
    const failA = { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "a" } } as AnyMessage;
    const failB = { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "b" } } as AnyMessage;

    const output = await runSteps(ordering, [
      { inbound: newSessionRequest(1) },
      { inbound: newSessionRequest(2) },
      { outbound: a1 },
      { outbound: b1 },
      { outbound: a2 },
      { outbound: failA },
      { outbound: failB },
    ]);

    // Neither creation returned a session ID, so nothing can establish either one and
    // all three updates are released together. Grouping the buffer by session emits
    // a1, a2, b1 here, which reorders b1 against a2 on the wire even though this
    // boundary promises arrival order.
    expect(output).toEqual([failA, failB, a1, b1, a2]);
  });

  it("does not settle a correlation on an agent-initiated request that reuses the id", async () => {
    const ordering = new AcpSessionNewOrdering();
    const update = sessionUpdate("s");
    // The outbound stream also carries agent-to-client requests. A client-chosen id
    // can collide with an in-flight session/new, and settling on the id alone would
    // release this session's update before the result that introduces it.
    const permission = {
      jsonrpc: "2.0",
      id: 5,
      method: "session/request_permission",
      params: { options: [] },
    } as AnyMessage;
    const created = newSessionResponse(5, "s");

    await expect(
      runSteps(ordering, [
        { inbound: newSessionRequest(5) },
        { outbound: update },
        { outbound: permission },
        { outbound: created },
      ]),
    ).resolves.toEqual([permission, created, update]);
  });

  it("keeps arrival order across sessions when each creation settles in turn", async () => {
    const ordering = new AcpSessionNewOrdering();
    const a1 = sessionUpdate("sa", "a1");
    const b1 = sessionUpdate("sb", "b1");
    const a2 = sessionUpdate("sa", "a2");
    const resultA = newSessionResponse(1, "sa");
    const resultB = newSessionResponse(2, "sb");

    const output = await runSteps(ordering, [
      { inbound: newSessionRequest(1) },
      { inbound: newSessionRequest(2) },
      { outbound: a1 },
      { outbound: b1 },
      { outbound: a2 },
      { outbound: resultA },
      { outbound: resultB },
    ]);

    // Draining a2 alongside a1 would put it ahead of b1, which arrived first. The
    // queue drains from the front only, so a2 waits behind b1 until sb settles.
    expect(output).toEqual([resultA, a1, resultB, b1, a2]);
  });

  it("restores ordering after session/close frees tracking capacity", async () => {
    const ordering = new AcpSessionNewOrdering();
    const steps: Step[] = [];
    // One past the bound, so tracking is genuinely saturated before capacity returns.
    for (let id = 1; id <= 1025; id += 1) {
      steps.push(
        { inbound: newSessionRequest(id) },
        { outbound: newSessionResponse(id, `s${id}`) },
      );
    }
    // Capacity comes back, so the boundary must resume ordering rather than stay
    // failed open for the rest of the process.
    steps.push({
      inbound: {
        jsonrpc: "2.0",
        id: 9000,
        method: "session/close",
        params: { sessionId: "s1" },
      } as AnyMessage,
    });
    const update = sessionUpdate("after-capacity");
    const created = newSessionResponse(2000, "after-capacity");
    steps.push({ inbound: newSessionRequest(2000) }, { outbound: update }, { outbound: created });

    const output = await runSteps(ordering, steps);

    expect(output.slice(-2)).toEqual([created, update]);
  });

  it("stops buffering once established tracking is saturated", async () => {
    const ordering = new AcpSessionNewOrdering();
    const steps: Step[] = [];
    for (let id = 1; id <= 1025; id += 1) {
      steps.push(
        { inbound: newSessionRequest(id) },
        { outbound: newSessionResponse(id, `s${id}`) },
      );
    }
    const late = sessionUpdate("late-session");
    const lateResult = newSessionResponse(5000, "late-session");
    steps.push({ inbound: newSessionRequest(5000) }, { outbound: late }, { outbound: lateResult });

    const output = await runSteps(ordering, steps);

    // Past the bound the boundary can no longer tell established from pending, so it
    // fails open in arrival order rather than holding an update it may never release.
    expect(output.slice(-2)).toEqual([late, lateResult]);
  });
});
