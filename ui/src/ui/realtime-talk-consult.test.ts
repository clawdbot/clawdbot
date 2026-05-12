/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { submitRealtimeTalkConsult } from "./chat/realtime-talk-shared.js";

function requireFirstMockCall(calls: readonly unknown[][], label: string): unknown[] {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("RealtimeTalkSession consult handoff", () => {
  it("submits realtime consults through the Gateway tool-call endpoint", async () => {
    let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "talk.client.toolCall") {
        setImmediate(() => {
          listener?.({
            event: "chat",
            payload: {
              runId: "run-1",
              state: "final",
              message: { text: "Basement lights are off." },
            },
          });
        });
        return { runId: "run-1" };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const addEventListener = vi.fn((callback: typeof listener) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    });
    const submit = vi.fn();

    await submitRealtimeTalkConsult({
      ctx: {
        client: { request, addEventListener },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      callId: "call-1",
      args: { question: "Are the basement lights off?" },
      submit,
    });

    const toolCall = requireFirstMockCall(request.mock.calls, "Gateway request") as
      | [string, { sessionKey?: string; name?: string; args?: { question?: string } }]
      | undefined;
    expect(toolCall?.[0]).toBe("talk.client.toolCall");
    expect(toolCall?.[1]?.sessionKey).toBe("agent:main:main");
    expect(toolCall?.[1]?.name).toBe("openclaw_agent_consult");
    expect(toolCall?.[1]?.args).toEqual({ question: "Are the basement lights off?" });
    expect(submit).toHaveBeenCalledWith("call-1", { result: "Basement lights are off." });
  });
});
