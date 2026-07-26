/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import {
  steerRealtimeTalkActiveConsult,
  submitRealtimeTalkConsult,
} from "./realtime-talk-shared.ts";

function requireFirstMockCall(calls: readonly unknown[][], label: string): unknown[] {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("RealtimeTalkSession consult handoff", () => {
  it("submits realtime consults through the Gateway tool-call endpoint", async () => {
    const order: string[] = [];
    let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "talk.client.toolCall") {
        order.push("tool-call");
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
    const flushTranscriptWrites = vi.fn(async () => {
      order.push("flush");
    });

    await submitRealtimeTalkConsult({
      ctx: {
        client: { request, addEventListener },
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-1",
        flushTranscriptWrites,
        callbacks: {},
      } as never,
      callId: "call-1",
      args: { question: "Are the basement lights off?" },
      submit,
    });

    const toolCall = requireFirstMockCall(request.mock.calls, "Gateway request") as
      | [
          string,
          {
            sessionKey?: string;
            voiceSessionId?: string;
            name?: string;
            args?: { question?: string };
          },
        ]
      | undefined;
    expect(toolCall?.[0]).toBe("talk.client.toolCall");
    expect(toolCall?.[1]?.sessionKey).toBe("agent:main:main");
    expect(toolCall?.[1]).toMatchObject({ voiceSessionId: "voice-1" });
    expect(toolCall?.[1]?.name).toBe("openclaw_agent_consult");
    expect(toolCall?.[1]?.args).toEqual({ question: "Are the basement lights off?" });
    expect(submit).toHaveBeenCalledWith("call-1", { result: "Basement lights are off." });
    expect(order).toEqual(["flush", "tool-call"]);
  });

  it("prefers source-reply final text over an earlier empty Talk consult final", async () => {
    let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        setImmediate(() => {
          listener?.({
            event: "chat",
            payload: {
              runId: "run-1",
              state: "final",
              message: undefined,
            },
          });
          listener?.({
            event: "chat",
            payload: {
              runId: "run-1",
              state: "final",
              message: {
                role: "assistant",
                provider: "openclaw",
                model: "delivery-mirror",
                text: "The requested status is green.",
              },
            },
          });
        });
        return { runId: "run-1" };
      }
      if (method === "agent.wait") {
        return { runId: "run-1", status: "ok" };
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
      args: { question: "Check status" },
      submit,
    });

    expect(submit).toHaveBeenCalledWith("call-1", {
      result: "The requested status is green.",
    });
  });

  it("waits past the old empty-final grace window for delayed source-reply final text", async () => {
    vi.useFakeTimers();
    try {
      let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.toolCall") {
          window.setTimeout(() => {
            listener?.({
              event: "chat",
              payload: {
                runId: "run-1",
                state: "final",
                message: undefined,
              },
            });
            window.setTimeout(() => {
              listener?.({
                event: "chat",
                payload: {
                  runId: "run-1",
                  state: "final",
                  message: {
                    role: "assistant",
                    provider: "openclaw",
                    model: "delivery-mirror",
                    text: "The slow source reply wins.",
                  },
                },
              });
            }, 300);
          }, 0);
          return { runId: "run-1" };
        }
        if (method === "agent.wait") {
          return new Promise(() => {});
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

      const consult = submitRealtimeTalkConsult({
        ctx: {
          client: { request, addEventListener },
          sessionKey: "agent:main:main",
          callbacks: {},
        } as never,
        callId: "call-1",
        args: { question: "Check status" },
        submit,
      });

      await vi.advanceTimersByTimeAsync(251);
      expect(submit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);
      await consult;

      expect(submit).toHaveBeenCalledWith("call-1", {
        result: "The slow source reply wins.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps source-reply final text when the empty-final wait completes later", async () => {
    let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
    let resolveWait: ((value: { runId: string; status: "ok" }) => void) | undefined;
    const waitResult = new Promise<{ runId: string; status: "ok" }>((resolve) => {
      resolveWait = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        setImmediate(() => {
          listener?.({
            event: "chat",
            payload: {
              runId: "run-1",
              state: "final",
              message: undefined,
            },
          });
          setImmediate(() => {
            listener?.({
              event: "chat",
              payload: {
                runId: "run-1",
                state: "final",
                message: {
                  role: "assistant",
                  provider: "openclaw",
                  model: "delivery-mirror",
                  text: "The source reply still wins.",
                },
              },
            });
          });
        });
        return { runId: "run-1" };
      }
      if (method === "agent.wait") {
        return await waitResult;
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
      args: { question: "Check status" },
      submit,
    });
    resolveWait?.({ runId: "run-1", status: "ok" });
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("agent.wait", {
      runId: "run-1",
      timeoutMs: 120_000,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("call-1", {
      result: "The source reply still wins.",
    });
  });

  it("keeps source-reply final text when the empty-final wait completes first", async () => {
    vi.useFakeTimers();
    try {
      let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.toolCall") {
          window.setTimeout(() => {
            listener?.({
              event: "chat",
              payload: {
                runId: "run-1",
                state: "final",
                message: undefined,
              },
            });
            window.setTimeout(() => {
              listener?.({
                event: "chat",
                payload: {
                  runId: "run-1",
                  state: "final",
                  message: {
                    role: "assistant",
                    provider: "openclaw",
                    model: "delivery-mirror",
                    text: "The source reply beats the fallback.",
                  },
                },
              });
            }, 300);
          }, 0);
          return { runId: "run-1" };
        }
        if (method === "agent.wait") {
          return { runId: "run-1", status: "ok" };
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

      const consult = submitRealtimeTalkConsult({
        ctx: {
          client: { request, addEventListener },
          sessionKey: "agent:main:main",
          callbacks: {},
        } as never,
        callId: "call-1",
        args: { question: "Check status" },
        submit,
      });

      await vi.advanceTimersByTimeAsync(300);
      await consult;

      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith("call-1", {
        result: "The source reply beats the fallback.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits the no-text fallback after an empty final and completed Gateway run", async () => {
    let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        setImmediate(() => {
          listener?.({
            event: "chat",
            payload: {
              runId: "run-1",
              state: "final",
              message: undefined,
            },
          });
        });
        return { runId: "run-1" };
      }
      if (method === "agent.wait") {
        return { runId: "run-1", status: "ok" };
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
      args: { question: "Check status" },
      submit,
    });

    expect(request).toHaveBeenCalledWith("agent.wait", {
      runId: "run-1",
      timeoutMs: 120_000,
    });
    expect(submit).toHaveBeenCalledWith("call-1", {
      result: "OpenClaw finished with no text.",
    });
  });

  it.each([
    {
      waitResult: { runId: "run-1", status: "error", error: "provider authentication failed" },
      expected: "provider authentication failed",
    },
    {
      waitResult: {
        runId: "run-1",
        status: "timeout",
        stopReason: "rpc",
        error: "aborted by operator",
      },
      expected: "aborted by operator",
    },
    {
      waitResult: {
        runId: "run-1",
        status: "timeout",
        error: "preflight setup timed out",
        timeoutPhase: "preflight",
      },
      expected: "preflight setup timed out",
    },
    {
      waitResult: {
        runId: "run-1",
        status: "timeout",
        error: "post-turn cleanup timed out",
        timeoutPhase: "post_turn",
      },
      expected: "post-turn cleanup timed out",
    },
    {
      waitResult: {
        runId: "run-1",
        status: "timeout",
        stopReason: "timeout",
        error: "agent runtime timeout",
      },
      expected: "agent runtime timeout",
    },
  ])("submits $expected from terminal empty-final waits", async ({ waitResult, expected }) => {
    let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        setImmediate(() => {
          listener?.({
            event: "chat",
            payload: {
              runId: "run-1",
              state: "final",
              message: undefined,
            },
          });
        });
        return { runId: "run-1" };
      }
      if (method === "agent.wait") {
        return waitResult;
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
      args: { question: "Check status" },
      submit,
    });

    expect(submit).toHaveBeenCalledWith("call-1", { error: expected });
  });

  it("emits Talk progress from chat tool events while waiting for the consult result", async () => {
    let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        setImmediate(() => {
          listener?.({
            event: "chat",
            payload: {
              runId: "run-1",
              stream: "tool",
              data: { phase: "start", name: "read", toolCallId: "tool-1" },
            },
          });
          listener?.({
            event: "chat",
            payload: {
              runId: "run-1",
              state: "final",
              message: { text: "Done." },
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
    const emitTalkEvent = vi.fn();

    await submitRealtimeTalkConsult({
      ctx: {
        client: { request, addEventListener },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      callId: "call-1",
      args: { question: "Check files" },
      submit: vi.fn(),
      emitTalkEvent,
    });

    expect(emitTalkEvent).toHaveBeenCalledWith({
      type: "tool.progress",
      callId: "tool-1",
      payload: { runId: "run-1", name: "read", phase: "start" },
    });
  });

  it("submits a cancellation result when an active consult run is aborted", async () => {
    let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        setImmediate(() => {
          listener?.({
            event: "chat",
            payload: {
              runId: "run-1",
              state: "aborted",
              errorMessage: "voice cancel",
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
      args: { question: "Check files" },
      submit,
    });

    expect(submit).toHaveBeenCalledWith("call-1", {
      status: "cancelled",
      message: "Cancelled the active OpenClaw run.",
    });
  });

  it("routes active consult steering through Gateway control endpoints", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      mode: "steer",
      sessionKey: "agent:main:main",
      active: true,
      queued: true,
      message: "Got it. I steered the active run.",
      speak: true,
      show: true,
      suppress: false,
    }));
    const emitTalkEvent = vi.fn();

    await steerRealtimeTalkActiveConsult({
      ctx: {
        client: { request, addEventListener: vi.fn() },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      text: "use the safer path",
      emitTalkEvent,
    });

    expect(request).toHaveBeenCalledWith("talk.client.steer", {
      sessionKey: "agent:main:main",
      text: "use the safer path",
    });
    expect(emitTalkEvent).toHaveBeenCalledWith({
      type: "tool.progress",
      payload: {
        name: "openclaw_agent_control",
        result: expect.objectContaining({ mode: "steer" }),
      },
      final: false,
    });
  });

  it("speaks status and cancel acknowledgements when requested by active consult steering", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      mode: "status",
      sessionKey: "agent:main:main",
      active: true,
      message: "OpenClaw is working in read (running).",
      speak: true,
      show: true,
      suppress: false,
    }));
    const speakControlResult = vi.fn();

    await steerRealtimeTalkActiveConsult({
      ctx: {
        client: { request, addEventListener: vi.fn() },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      text: "status",
      speakControlResult,
    });

    expect(speakControlResult).toHaveBeenCalledWith(
      expect.stringContaining('Status: "OpenClaw is working in read (running)."'),
    );
  });

  it("can suppress cancel control speech while the original consult submits the cancel result", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      mode: "cancel",
      sessionKey: "agent:main:main",
      active: true,
      aborted: true,
      message: "Cancelled the active OpenClaw run.",
      speak: true,
      show: true,
      suppress: false,
    }));
    const speakControlResult = vi.fn();

    await steerRealtimeTalkActiveConsult({
      ctx: {
        client: { request, addEventListener: vi.fn() },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      text: "cancel that",
      speakControlResult,
      suppressSpeechForModes: ["cancel"],
    });

    expect(request).toHaveBeenCalledWith("talk.client.steer", {
      sessionKey: "agent:main:main",
      text: "cancel that",
    });
    expect(speakControlResult).not.toHaveBeenCalled();
  });

  it("speaks legacy suppressed steer acknowledgements instead of leaving voice silent", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      mode: "steer",
      sessionKey: "agent:main:main",
      active: true,
      queued: true,
      message: "Got it. I steered the active run.",
      speak: false,
      show: true,
      suppress: true,
    }));
    const speakControlResult = vi.fn();

    await steerRealtimeTalkActiveConsult({
      ctx: {
        client: { request, addEventListener: vi.fn() },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      text: "use the safer path",
      speakControlResult,
    });

    expect(speakControlResult).toHaveBeenCalledWith(
      expect.stringContaining('Status: "Got it. I steered the active run."'),
    );
  });
});
