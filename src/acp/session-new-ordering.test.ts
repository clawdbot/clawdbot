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

    // `session/prompt` is valid-shaped but the translator rejects an unknown session.
    // Recording it here would let any peer grow the set for the process lifetime.
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
        { outbound: sessionUpdate("never-created") },
      ]),
    ).resolves.toEqual([]);
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
      ...buffered.map((outbound) => ({ outbound })),
      { outbound: overflow },
    ]);

    // Failing open preserves the update; only its ordering degrades to pre-fix behavior.
    expect(output).toEqual([overflow]);
  });
});
