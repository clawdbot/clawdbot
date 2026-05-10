/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { submitRealtimeTalkConsult } from "./chat/realtime-talk-shared.js";

describe("RealtimeTalkSession consult handoff", () => {
  it("submits realtime consults through the Gateway tool-call endpoint", async () => {
    let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "talk.client.toolCall") {
        window.setTimeout(() => {
          listener?.({
            event: "chat",
            payload: {
              runId: "run-1",
              state: "final",
              message: { text: "Basement lights are off." },
            },
          });
        }, 0);
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

    expect(request).toHaveBeenCalledWith(
      "talk.client.toolCall",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        name: "openclaw_agent_consult",
        args: { question: "Are the basement lights off?" },
      }),
    );
    expect(submit).toHaveBeenCalledWith("call-1", { result: "Basement lights are off." });
  });
});
