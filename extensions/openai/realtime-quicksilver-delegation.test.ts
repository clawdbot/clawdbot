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
  requesterFinal?: { append: (text: string) => boolean };
}) => Promise<{ text: string; yielded?: true }>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createDelegationHarness(params?: {
  claimAppend?: () => boolean;
  isCanceledError?: (error: unknown) => boolean;
  revokeRequesterFinal?: () => void;
  runAgentConsult?: ConsultRunner;
  steerAgentConsult?: (params: { prompt: string; signal?: AbortSignal }) => Promise<void>;
}) {
  const socket = new FakeSocket("manual");
  socket.readyState = 1;
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const onFatalError = vi.fn();
  const sessionController = new AbortController();
  const runAgentConsult = Object.assign(
    params?.runAgentConsult ?? vi.fn(async () => ({ text: "Done" })),
    {
      ...(params?.claimAppend ? { claimAppend: params.claimAppend } : {}),
      ...(params?.revokeRequesterFinal
        ? { revokeRequesterFinal: params.revokeRequesterFinal }
        : {}),
      ...(params?.steerAgentConsult ? { steer: params.steerAgentConsult } : {}),
    },
  );
  const controller = new OpenAIQuicksilverDelegationController({
    getSocket: () => socket,
    isCanceledError: params?.isCanceledError,
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
      expect(runAgentConsult).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "<realtime_delegation>\n  <input>first task</input>\n</realtime_delegation>",
          signal: expect.any(AbortSignal),
          requesterFinal: { append: expect.any(Function) },
        }),
      ),
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

  it("frees the delegation lane after yield and appends the exact late final once", async () => {
    let appendRequesterFinal: ((text: string) => boolean) | undefined;
    const runAgentConsult = vi.fn<ConsultRunner>(async ({ requesterFinal }) => {
      appendRequesterFinal = requesterFinal?.append;
      return { text: "I started that work.", yielded: true };
    });
    const { controller, socket } = createDelegationHarness({ runAgentConsult });

    delegate(controller, "delegation-yielded", "investigate");
    await vi.waitFor(() =>
      expect(parseSent(socket)).toContainEqual(
        expect.objectContaining({
          delegation_item_id: "delegation-yielded",
          content: [{ type: "input_text", text: "I started that work." }],
        }),
      ),
    );
    expect(appendRequesterFinal?.("consolidated final")).toBe(true);
    expect(appendRequesterFinal?.("duplicate final")).toBe(false);

    delegate(controller, "delegation-next", "next question");
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(2));
    expect(
      parseSent(socket).filter(
        (event) =>
          event.type === "delegation.context.append" &&
          event.delegation_item_id === "delegation-yielded",
      ),
    ).toEqual([
      expect.objectContaining({
        content: [{ type: "input_text", text: "I started that work." }],
      }),
      expect.objectContaining({
        content: [{ type: "input_text", text: "consolidated final" }],
      }),
    ]);
  });

  it("revokes the old late-final owner on newer delegation and detach", async () => {
    const appends: Array<(text: string) => boolean> = [];
    const revokeRequesterFinal = vi.fn();
    const runAgentConsult = vi.fn<ConsultRunner>(async ({ requesterFinal }) => {
      if (requesterFinal) {
        appends.push(requesterFinal.append);
      }
      return { text: "started", yielded: true };
    });
    const { controller } = createDelegationHarness({
      revokeRequesterFinal,
      runAgentConsult,
    });

    delegate(controller, "delegation-old", "old task");
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(appends).toHaveLength(1));
    delegate(controller, "delegation-new", "new task");
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(2));
    expect(appends[0]?.("stale final")).toBe(false);

    controller.detach();
    expect(appends[1]?.("detached final")).toBe(false);
    expect(revokeRequesterFinal).toHaveBeenCalled();
  });

  it("consumes bounded transcript context once and in event order", async () => {
    const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "Done" }));
    const { controller, socket } = createDelegationHarness({ runAgentConsult });
    controller.handleEvent({ kind: "transcript-delta", role: "user", text: "hel" });
    controller.handleEvent({ kind: "transcript-done", role: "user", text: "hello" });
    controller.handleEvent({ kind: "transcript-delta", role: "assistant", text: "ack" });

    delegate(controller, "delegation-1", "check weather");
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    await Promise.resolve();
    await Promise.resolve();
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

  it("steers one accepted run and appends its final result only to the latest delegation", async () => {
    const result = deferred<{ text: string; yielded?: true }>();
    let consultSignal: AbortSignal | undefined;
    let appendRequesterFinal: ((text: string) => boolean) | undefined;
    const runAgentConsult = vi.fn<ConsultRunner>(async ({ requesterFinal, signal }) => {
      consultSignal = signal;
      appendRequesterFinal = requesterFinal?.append;
      return await result.promise;
    });
    const steerAgentConsult = vi.fn(async () => undefined);
    const { controller, socket } = createDelegationHarness({
      runAgentConsult,
      steerAgentConsult,
    });

    delegate(controller, "delegation-1", "first task");
    delegate(controller, "delegation-2", "second task");
    delegate(controller, "delegation-3", "latest task");

    expect(consultSignal?.aborted).toBe(false);
    expect(runAgentConsult).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(steerAgentConsult).toHaveBeenCalledOnce());
    expect(steerAgentConsult.mock.calls[0]?.[0].prompt).toContain("latest task");
    expect(steerAgentConsult.mock.calls[0]?.[0].prompt).not.toContain("second task");

    result.resolve({ text: "work continues", yielded: true });
    await vi.waitFor(() =>
      expect(parseSent(socket)).toContainEqual({
        type: "delegation.context.append",
        delegation_item_id: "delegation-3",
        channel: "speakable",
        content: [{ type: "input_text", text: "work continues" }],
      }),
    );
    expect(appendRequesterFinal?.("one parent result")).toBe(true);
    expect(appendRequesterFinal?.("duplicate result")).toBe(false);
    expect(
      parseSent(socket).filter(
        (event) =>
          event.type === "delegation.context.append" &&
          event.delegation_item_id === "delegation-3" &&
          event.content[0]?.text === "one parent result",
      ),
    ).toHaveLength(1);
    expect(
      parseSent(socket).filter(
        (event) =>
          event.type === "delegation.context.append" && event.delegation_item_id === "delegation-1",
      ),
    ).toEqual([]);
  });

  it("preserves abort-and-restart fallback for runners without steering", async () => {
    const runAgentConsult = vi.fn<ConsultRunner>(async ({ signal }) => {
      if (runAgentConsult.mock.calls.length === 1) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              const reason = signal.reason;
              reject(reason instanceof Error ? reason : new Error("delegation superseded"));
            },
            { once: true },
          );
        });
      }
      return { text: "replacement result" };
    });
    const { controller, socket } = createDelegationHarness({
      runAgentConsult,
      isCanceledError: () => true,
    });

    delegate(controller, "delegation-1", "first task");
    delegate(controller, "delegation-2", "second task");
    delegate(controller, "delegation-3", "latest task");

    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(2));
    expect(runAgentConsult.mock.calls[1]?.[0].prompt).toContain("latest task");
    await vi.waitFor(() =>
      expect(parseSent(socket)).toContainEqual(
        expect.objectContaining({ delegation_item_id: "delegation-3" }),
      ),
    );
  });

  it("suppresses the old result when steering fails", async () => {
    const result = deferred<{ text: string }>();
    let appendRequesterFinal: ((text: string) => boolean) | undefined;
    const { controller, onFatalError, socket } = createDelegationHarness({
      runAgentConsult: vi.fn(async ({ requesterFinal }) => {
        appendRequesterFinal = requesterFinal?.append;
        return await result.promise;
      }),
      steerAgentConsult: vi.fn(async () => {
        throw new Error("steering failed");
      }),
    });

    delegate(controller, "delegation-1", "first task");
    delegate(controller, "delegation-2", "new task");
    await vi.waitFor(() => expect(onFatalError).toHaveBeenCalledOnce());
    result.resolve({ text: "old result" });
    await Promise.resolve();
    await Promise.resolve();

    expect(parseSent(socket).filter((event) => event.type === "delegation.context.append")).toEqual(
      [],
    );
    expect(appendRequesterFinal?.("late stale result")).toBe(false);
  });

  it("suppresses final output when the host run owner is stale", async () => {
    const claimAppend = vi.fn(() => false);
    const { controller, socket } = createDelegationHarness({
      claimAppend,
      runAgentConsult: vi.fn(async () => ({ text: "stale result", claimAppend })),
    });

    delegate(controller, "delegation-stale", "check owner");

    await vi.waitFor(() => expect(claimAppend).toHaveBeenCalledOnce());
    expect(socket.sent).toEqual([]);
  });

  it("detaches provider transport without cancelling accepted host work", async () => {
    const result = deferred<{ text: string }>();
    let consultSignal: AbortSignal | undefined;
    const { controller, socket } = createDelegationHarness({
      runAgentConsult: vi.fn(async ({ signal }) => {
        consultSignal = signal;
        return await result.promise;
      }),
    });
    delegate(controller, "delegation-detached", "keep working");

    controller.detach();
    expect(consultSignal?.aborted).toBe(false);
    result.resolve({ text: "late detached result" });
    await Promise.resolve();
    await Promise.resolve();

    expect(socket.sent).toEqual([]);
  });

  it("cancels accepted host work on full session close", async () => {
    let consultSignal: AbortSignal | undefined;
    const { controller, socket } = createDelegationHarness({
      runAgentConsult: vi.fn(
        async ({ signal }) =>
          await new Promise<{ text: string }>((_resolve, reject) => {
            consultSignal = signal;
            signal?.addEventListener(
              "abort",
              () => {
                const reason = signal.reason;
                reject(reason instanceof Error ? reason : new Error("aborted"));
              },
              { once: true },
            );
          }),
      ),
      isCanceledError: () => true,
    });
    delegate(controller, "delegation-closed", "stop working");

    controller.stop(new Error("session closed"));
    await vi.waitFor(() => expect(consultSignal?.aborted).toBe(true));
    expect(socket.sent).toEqual([]);
  });

  it("keeps transcript context when it skips an empty delegation", async () => {
    const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "Done" }));
    const { controller } = createDelegationHarness({ runAgentConsult });
    controller.handleEvent({ kind: "transcript-done", role: "user", text: "hello" });

    delegate(controller, "empty", "  ");
    expect(runAgentConsult).not.toHaveBeenCalled();
    delegate(controller, "delegation-1", "check weather");

    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(1));
    expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain(
      "<transcript_delta>user: hello</transcript_delta>",
    );
  });

  it("returns only a fixed speakable failure when the delegated agent fails", async () => {
    const runAgentConsult = vi.fn<ConsultRunner>(async () => {
      throw new Error("workspace unavailable");
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
    expect(socket.sent.join("\n")).not.toContain("workspace unavailable");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("workspace unavailable"));
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
      isCanceledError: (error) => error === abortError,
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
