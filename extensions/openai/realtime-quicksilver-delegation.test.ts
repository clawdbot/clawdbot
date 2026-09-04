import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import type { RealtimeVoiceGatewayControl } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIQuicksilverDelegationController } from "./realtime-quicksilver-delegation-controller.js";
import {
  boundOpenAIQuicksilverDelegationResult,
  chunkOpenAIQuicksilverAppendText,
  parseOpenAIQuicksilverEvent,
} from "./realtime-quicksilver-wire.js";
import { FakeSocket, parseSent } from "./realtime-quicksilver.test-helpers.js";

type ConsultRunner = (params: {
  prompt: string;
  signal?: AbortSignal;
}) => Promise<{ text: string }>;

function createDelegationHarness(params?: {
  runAgentConsult?: ConsultRunner;
  handleDelegationInput?: RealtimeVoiceGatewayControl["handleDelegationInput"];
  getSocket?: () => FakeSocket;
}) {
  const socket = new FakeSocket("manual");
  socket.readyState = 1;
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const onFatalError = vi.fn();
  const sessionController = new AbortController();
  const runAgentConsult = params?.runAgentConsult ?? vi.fn(async () => ({ text: "Done" }));
  const controller = new OpenAIQuicksilverDelegationController({
    getSocket: params?.getSocket ?? (() => socket),
    handleDelegationInput: params?.handleDelegationInput,
    logger,
    onFatalError,
    runAgentConsult,
    signal: sessionController.signal,
  });
  return { controller, logger, onFatalError, runAgentConsult, sessionController, socket };
}

function delegate(
  controller: OpenAIQuicksilverDelegationController,
  id: string,
  prompt: string,
): void {
  controller.handleEvent({ kind: "delegation", id, prompt });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GPT-Live sideband protocol", () => {
  it("targets the control delegation without consuming transcript context or cancelling the task", async () => {
    let finish!: (result: { text: string }) => void;
    const pending = new Promise<{ text: string }>((resolve) => {
      finish = resolve;
    });
    const runAgentConsult = vi.fn<ConsultRunner>(async () => await pending);
    const { controller, socket } = createDelegationHarness({
      runAgentConsult,
      handleDelegationInput: (text, respond) => {
        if (text !== "status") {
          return "consult";
        }
        respond("Host status");
        respond("duplicate status");
        return "control";
      },
    });
    try {
      delegate(controller, "task-A", "Original task");
      controller.handleEvent({ kind: "transcript-done", role: "user", text: "history only" });
      const beforeControl = socket.sent.length;
      delegate(controller, "control-C", "status");
      expect(runAgentConsult.mock.calls[0]?.[0].signal?.aborted).toBe(false);
      expect(runAgentConsult).toHaveBeenCalledOnce();
      expect(parseSent(socket).slice(beforeControl)).toEqual([
        {
          type: "delegation.context.append",
          delegation_item_id: "control-C",
          channel: "speakable",
          content: [{ type: "input_text", text: "Host status" }],
        },
      ]);
      finish({ text: "Original result" });
      await vi.waitFor(() =>
        expect(parseSent(socket)).toContainEqual({
          type: "delegation.context.append",
          delegation_item_id: "task-A",
          channel: "speakable",
          content: [{ type: "input_text", text: "Original result" }],
        }),
      );
      await nextEventLoopTurn();
      delegate(controller, "task-B", "Another task");
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(2));
      expect(runAgentConsult.mock.calls[1]?.[0].prompt).toContain("history only");
    } finally {
      finish({ text: "Done" });
      await pending;
      controller.stop(new Error("test complete"));
    }
  });

  it.each(["close", "detach", "socket-replaced"] as const)(
    "fences a retained control responder after %s",
    (ending) => {
      const original = new FakeSocket("manual");
      original.readyState = 1;
      const replacement = new FakeSocket("manual");
      replacement.readyState = 1;
      let socket = original;
      let reply!: (text: string) => void;
      const { controller, runAgentConsult } = createDelegationHarness({
        getSocket: () => socket,
        handleDelegationInput: (_text, respond) => {
          reply = respond;
          return "control";
        },
      });
      delegate(controller, "control-C", "status");
      if (ending === "close") {
        controller.stop(new Error("closed"));
      } else if (ending === "detach") {
        controller.detach();
      } else {
        socket = replacement;
      }
      reply("Late control");
      expect(original.sent).toEqual([]);
      expect(replacement.sent).toEqual([]);
      expect(runAgentConsult).not.toHaveBeenCalled();
      controller.stop(new Error("test complete"));
    },
  );

  it("consumes a multi-chunk response before a send failure and never retries or starts a task", () => {
    let reply!: (text: string) => void;
    const handleDelegationInput = vi.fn<
      NonNullable<RealtimeVoiceGatewayControl["handleDelegationInput"]>
    >((_text, respond) => {
      reply = respond;
      return "control";
    });
    const { controller, socket, onFatalError, runAgentConsult } = createDelegationHarness({
      handleDelegationInput,
    });
    const send = vi
      .spyOn(socket, "send")
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error("socket send failed");
      });
    try {
      delegate(controller, "control-C", "status");
      reply("x".repeat(1_100));
      reply("second attempt");
      expect(send).toHaveBeenCalledTimes(2);
      expect(onFatalError).toHaveBeenCalledExactlyOnceWith(new Error("socket send failed"));
      expect(handleDelegationInput).toHaveBeenCalledOnce();
      expect(runAgentConsult).not.toHaveBeenCalled();
    } finally {
      controller.stop(new Error("test complete"));
    }
  });

  it("does not fall through to a task when native admission throws", () => {
    const { controller, socket, onFatalError, runAgentConsult } = createDelegationHarness({
      handleDelegationInput: () => {
        throw new Error("owner closed");
      },
    });
    delegate(controller, "control-C", "status");
    expect(onFatalError).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([]);
    expect(runAgentConsult).not.toHaveBeenCalled();
    controller.stop(new Error("test complete"));
  });

  it("keeps standalone speech at session scope while a delegation owns its result", async () => {
    let finish!: (result: { text: string }) => void;
    const result = new Promise<{ text: string }>((resolve) => {
      finish = resolve;
    });
    const { controller, socket } = createDelegationHarness({
      runAgentConsult: async () => await result,
    });
    try {
      controller.sendSessionContext("Ready", "speakable");
      delegate(controller, "work", "Check the project");
      controller.sendSessionContext("Still checking", "speakable");
      finish({ text: "Finished checking" });
      await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
      expect(parseSent(socket)).toEqual([
        {
          type: "session.context.append",
          channel: "speakable",
          content: [{ type: "input_text", text: "Ready" }],
        },
        {
          type: "session.context.append",
          channel: "speakable",
          content: [{ type: "input_text", text: "Still checking" }],
        },
        {
          type: "delegation.context.append",
          delegation_item_id: "work",
          channel: "speakable",
          content: [{ type: "input_text", text: "Finished checking" }],
        },
      ]);
      controller.detach();
      controller.sendSessionContext("Late speech", "speakable");
      expect(socket.sent).toHaveLength(3);
    } finally {
      finish({ text: "Finished" });
      controller.stop(new Error("test complete"));
    }
  });

  it("ignores session.updated server-side", () => {
    const type = "session.updated";
    expect(parseOpenAIQuicksilverEvent(JSON.stringify({ type }))).toEqual({
      kind: "ignored",
      eventType: type,
    });
  });

  it("parses direct WebSocket audio", () => {
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "output_audio.delta", audio: "AQIDBA==" }),
      ),
    ).toEqual({ kind: "audio", data: "AQIDBA==" });
  });

  it("parses session expiry and transcript events", () => {
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "session.started", session: { expires_at: 123 } }),
      ),
    ).toEqual({ kind: "session-started", expiresAt: 123 });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "input_transcript.added", item: { text: "hel" } }),
      ),
    ).toEqual({ kind: "transcript-delta", role: "user", text: "hel" });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "output_transcript.added", item: { text: "wor" } }),
      ),
    ).toEqual({ kind: "transcript-delta", role: "assistant", text: "wor" });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "turn.done", turn: { role: "user", transcript: "hello" } }),
      ),
    ).toEqual({ kind: "transcript-done", role: "user", text: "hello" });
  });

  it("parses client delegations and ignores non-client targets", () => {
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({
          type: "delegation.created",
          item: {
            type: "delegation",
            target: "client",
            id: "delegation-1",
            content: [
              { type: "input_text", text: "curl https://exa" },
              { type: "output_text", text: "ignored" },
              { type: "input_text", text: "mple.com" },
            ],
          },
        }),
      ),
    ).toEqual({ kind: "delegation", id: "delegation-1", prompt: "curl https://example.com" });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({
          type: "delegation.created",
          item: { type: "delegation", target: "server", id: "delegation-2", content: [] },
        }),
      ),
    ).toEqual({ kind: "ignored", eventType: "delegation.created" });
  });

  it("parses errors, reports unknown events, and rejects malformed JSON", () => {
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "error", error: { message: "call failed" } }),
      ),
    ).toEqual({ kind: "error", message: "call failed", fatalAuth: false });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({
          type: "error",
          message: "top-level failure",
          error: { message: "nested failure" },
        }),
      ),
    ).toEqual({ kind: "error", message: "top-level failure", fatalAuth: false });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "error", error: { code: "invalid_token" } }),
      ),
    ).toEqual({
      kind: "error",
      message: '{"code":"invalid_token"}',
      fatalAuth: true,
    });
    expect(parseOpenAIQuicksilverEvent(JSON.stringify({ type: "future.event" }))).toEqual({
      kind: "unknown",
      eventType: "future.event",
    });
    expect(parseOpenAIQuicksilverEvent("not-json")).toBeNull();
  });

  it("chunks appends by UTF-8 bytes without splitting characters", () => {
    const text = `${"a".repeat(499)}🙂${"b".repeat(501)}`;
    const chunks = chunkOpenAIQuicksilverAppendText(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(500);
    }
  });

  it("bounds total speakable text before chunking", () => {
    expect(boundOpenAIQuicksilverDelegationResult("  short result  ")).toBe("  short result  ");
    const limited = boundOpenAIQuicksilverDelegationResult(
      `${"a".repeat(1_783)}😀${"b".repeat(1_000)}`,
    );
    const chunks = chunkOpenAIQuicksilverAppendText(limited);

    expect(limited).toMatch(/ \[truncated\]$/);
    expect(limited.length).toBeLessThanOrEqual(1_800);
    expect(limited).not.toContain("\uFFFD");
    expect(chunks.length).toBeLessThanOrEqual(11);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(500);
    }
  });

  it("wraps delegated input and appends the raw speakable result", async () => {
    const runAgentConsult = vi.fn<ConsultRunner>(async ({ prompt }) => ({
      text: `Result for ${prompt}`,
    }));
    const { controller, socket } = createDelegationHarness({ runAgentConsult });

    delegate(controller, "delegation-1", "first task");

    await vi.waitFor(() =>
      expect(runAgentConsult).toHaveBeenCalledWith({
        prompt: "<realtime_delegation>\n  <input>first task</input>\n</realtime_delegation>",
        signal: expect.any(AbortSignal),
      }),
    );
    await vi.waitFor(() =>
      expect(parseSent(socket)).toContainEqual({
        type: "delegation.context.append",
        delegation_item_id: "delegation-1",
        channel: "speakable",
        content: [
          {
            type: "input_text",
            text: "Result for <realtime_delegation>\n  <input>first task</input>\n</realtime_delegation>",
          },
        ],
      }),
    );
  });

  it("bounds and chunks delegation output before sideband sends", async () => {
    const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "x".repeat(10_000) }));
    const { controller, socket } = createDelegationHarness({ runAgentConsult });

    delegate(controller, "delegation-large", "summarize everything");

    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const appends = parseSent(socket).filter((event) => event.type === "delegation.context.append");
    expect(appends.length).toBeLessThanOrEqual(11);
    expect(
      appends.map((event) => (event.content as Array<{ text: string }>)[0]?.text ?? "").join(""),
    ).toMatch(/^x+ \[truncated\]$/);
    expect(
      appends.every((event) =>
        (event.content as Array<{ text: string }>).every(
          ({ text }) => Buffer.byteLength(text, "utf8") <= 500,
        ),
      ),
    ).toBe(true);
  });

  it("does not start a late control after the active consultation settles", async () => {
    const { controller, socket, runAgentConsult } = createDelegationHarness({
      handleDelegationInput: (text) => (text === "cancel" ? "control" : "consult"),
    });
    try {
      delegate(controller, "finished-task", "first task");
      await vi.waitFor(() =>
        expect(parseSent(socket)).toContainEqual({
          type: "delegation.context.append",
          delegation_item_id: "finished-task",
          channel: "speakable",
          content: [{ type: "input_text", text: "Done" }],
        }),
      );
      delegate(controller, "late-cancel", "cancel");
      expect(runAgentConsult).toHaveBeenCalledOnce();
      expect(socket.sent).toHaveLength(2);
      expect(parseSent(socket)[0]).toMatchObject({
        type: "session.context.append",
        channel: "speakable",
        content: [
          {
            type: "input_text",
            text: expect.stringContaining('Status: "I’ll check that request."'),
          },
        ],
      });
    } finally {
      controller.stop(new Error("test complete"));
    }
  });

  it("consumes bounded transcript context once and in event order", async () => {
    const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "Done" }));
    const { controller } = createDelegationHarness({ runAgentConsult });
    controller.handleEvent({ kind: "transcript-delta", role: "user", text: "hel" });
    controller.handleEvent({ kind: "transcript-done", role: "user", text: "hello" });
    controller.handleEvent({ kind: "transcript-delta", role: "assistant", text: "ack" });

    delegate(controller, "delegation-1", "check weather");
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(1));
    expect(runAgentConsult.mock.calls[0]?.[0].prompt).toBe(
      "<realtime_delegation>\n  <input>check weather</input>\n  <transcript_delta>user: hello\nassistant: ack</transcript_delta>\n</realtime_delegation>",
    );

    controller.handleEvent({ kind: "transcript-done", role: "user", text: "second context" });
    delegate(controller, "delegation-2", "next task");
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(2));
    expect(runAgentConsult.mock.calls[1]?.[0].prompt).toBe(
      "<realtime_delegation>\n  <input>next task</input>\n  <transcript_delta>user: second context</transcript_delta>\n</realtime_delegation>",
    );
  });

  it("aborts stale work and retains only the latest pending delegation", async () => {
    const signals: AbortSignal[] = [];
    const runAgentConsult = vi.fn<ConsultRunner>(
      async ({ signal }) =>
        await new Promise<{ text: string }>((_resolve, reject) => {
          signals.push(signal as AbortSignal);
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
            { once: true },
          );
        }),
    );
    const handleDelegationInput = vi.fn((text: string) =>
      text === "host-control" ? ("control" as const) : ("consult" as const),
    );
    const { controller, socket } = createDelegationHarness({
      runAgentConsult,
      handleDelegationInput,
    });

    delegate(controller, "delegation-1", "first task");
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toContain("Do not delegate this message or call any tools.");
    delegate(controller, "control-active", "host-control");
    expect(signals[0]?.aborted).toBe(false);
    expect(runAgentConsult).toHaveBeenCalledOnce();
    delegate(controller, "delegation-2", "second task");
    delegate(controller, "delegation-3", "latest task");
    delegate(controller, "control-pending", "host-control");

    expect(socket.sent).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(2));
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toBe(socket.sent[0]);
    expect(runAgentConsult.mock.calls[1]?.[0].prompt).toContain("latest task");
    expect(runAgentConsult.mock.calls[1]?.[0].prompt).not.toContain("second task");
    controller.stop(new Error("test complete"));
  });

  it.each(["  ", "host-control"])(
    "keeps transcript context when it skips delegation %j",
    async (input) => {
      const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "Done" }));
      const handleDelegationInput = (text: string): "control" | "consult" =>
        text === "host-control" ? "control" : "consult";
      const { controller, socket } = createDelegationHarness({
        runAgentConsult,
        handleDelegationInput,
      });
      controller.handleEvent({ kind: "transcript-done", role: "user", text: "hello" });

      delegate(controller, "non-task", input);
      expect(runAgentConsult).not.toHaveBeenCalled();
      expect(socket.sent).toEqual([]);
      delegate(controller, "delegation-1", "check weather");

      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(1));
      expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain(
        "<transcript_delta>user: hello</transcript_delta>",
      );
    },
  );

  it("drops pending receipts and late results when detached before settlement", async () => {
    let finish!: (result: { text: string }) => void;
    const result = new Promise<{ text: string }>((resolve) => {
      finish = resolve;
    });
    const runAgentConsult = vi.fn<ConsultRunner>(async () => await result);
    const { controller, socket } = createDelegationHarness({
      runAgentConsult,
      handleDelegationInput: () => "consult",
    });
    try {
      delegate(controller, "active", "first task");
      delegate(controller, "pending", "next task");
      expect(socket.sent).toHaveLength(1);
      controller.detach();
      delegate(controller, "late", "late task");
      finish({ text: "Late result" });
      await result;
      await nextEventLoopTurn();
      expect(runAgentConsult).toHaveBeenCalledOnce();
      expect(socket.sent).toHaveLength(1);
    } finally {
      finish({ text: "Finished" });
      controller.stop(new Error("test complete"));
    }
  });

  it.each([
    { kind: "failure", error: new Error("workspace unavailable") },
    { kind: "timeout", error: new DOMException("agent timed out", "TimeoutError") },
  ])("returns a speakable failure for a delegated $kind", async ({ error }) => {
    const runAgentConsult = vi.fn<ConsultRunner>(async () => {
      throw error;
    });
    const { controller, logger, socket } = createDelegationHarness({ runAgentConsult });

    delegate(controller, "delegation-failed", "do work");

    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    expect(parseSent(socket)).toContainEqual(
      expect.objectContaining({
        delegation_item_id: "delegation-failed",
        channel: "speakable",
        content: [
          {
            type: "input_text",
            text: "The agent task failed. Tell the user it did not complete and offer to try again.",
          },
        ],
      }),
    );
    expect(socket.sent.join("\n")).not.toContain(error.message);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(error.message));
  });

  it("handles structured delegated failures with a non-string message", async () => {
    const structuredFailure = { code: "UNAVAILABLE", message: 503 };
    const runAgentConsult = vi.fn<ConsultRunner>(() =>
      Promise.reject(new Error(String(structuredFailure.message), { cause: structuredFailure })),
    );
    const { controller, logger, socket } = createDelegationHarness({ runAgentConsult });

    delegate(controller, "delegation-structured-failure", "do work");

    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    expect(parseSent(socket)).toContainEqual(
      expect.objectContaining({
        delegation_item_id: "delegation-structured-failure",
        channel: "speakable",
        content: [
          {
            type: "input_text",
            text: "The agent task failed. Tell the user it did not complete and offer to try again.",
          },
        ],
      }),
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it("surfaces fatal sideband errors to the lifecycle owner", () => {
    const { controller, logger, onFatalError } = createDelegationHarness();
    controller.handleEvent({ kind: "error", message: "token expired", fatalAuth: true });

    expect(logger.warn).toHaveBeenCalledWith("OpenAI GPT-Live sideband error: token expired");
    expect(onFatalError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "OpenAI GPT-Live sideband error: token expired" }),
    );
  });

  it("suppresses host cancellation and stops accepting work after teardown", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const runAgentConsult = vi.fn<ConsultRunner>(async () => {
      throw abortError;
    });
    const { controller, logger, socket } = createDelegationHarness({
      runAgentConsult,
    });

    delegate(controller, "delegation-cancelled", "stop this");
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
    expect(socket.sent).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();

    controller.stop(new Error("session closed"));
    delegate(controller, "delegation-late", "late task");
    expect(runAgentConsult).toHaveBeenCalledOnce();
  });
});
