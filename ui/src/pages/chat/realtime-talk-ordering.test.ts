// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createRealtimeTalkConversationState,
  orderRealtimeTalkConversation,
  updateRealtimeTalkConversation,
} from "./realtime-talk-conversation.ts";
import { useRealtimeTalkMicrophoneFixture } from "./realtime-talk-input.test-support.ts";
import type { RealtimeTalkTranscript } from "./realtime-talk-shared.ts";
import { RealtimeTalkSession } from "./realtime-talk.ts";

class Peer extends EventTarget {
  static instances: Peer[] = [];
  static setupBlock: (() => Promise<void>) | undefined;
  connectionState = "new";
  channel = Object.assign(new EventTarget(), {
    readyState: "open",
    send: vi.fn(),
    close: vi.fn(),
  });
  addTrack = vi.fn();
  createDataChannel = () => this.channel;
  createOffer = async () => ({ type: "offer", sdp: "offer-sdp" });
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => await Peer.setupBlock?.());
  close = vi.fn();

  constructor() {
    super();
    Peer.instances.push(this);
  }
}

useRealtimeTalkMicrophoneFixture();

function emit(peer: Peer, event: unknown): void {
  peer.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
}

function item(peer: Peer, id: string, role: "user" | "assistant", previous: string | null): void {
  emit(peer, {
    type: "conversation.item.added",
    previous_item_id: previous,
    item: {
      id,
      type: "message",
      role,
      content: role === "user" ? [{ type: "input_audio", transcript: null }] : [],
    },
  });
}

function final(peer: Peer, id: string, role: "user" | "assistant", text: string): void {
  emit(peer, {
    type:
      role === "user"
        ? "conversation.item.input_audio_transcription.completed"
        : "response.output_audio_transcript.done",
    item_id: id,
    transcript: text,
  });
}

function createCall(onTranscript?: (entry: RealtimeTalkTranscript) => void) {
  let conversation = createRealtimeTalkConversationState();
  let nextVoiceSession = 0;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    requests.push({ method, params });
    return method === "talk.client.create"
      ? {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-${++nextVoiceSession}`,
          clientSecret: "test-secret",
        }
      : { ok: true };
  });
  const onStatus = vi.fn();
  const onTalkEvent = vi.fn();
  const session = new RealtimeTalkSession(
    { request } as unknown as GatewayBrowserClient,
    "agent:main:main",
    {
      onStatus,
      onTalkEvent,
      onTranscriptOrder: (orders) => {
        conversation = orderRealtimeTalkConversation(conversation, orders);
      },
      onTranscript: (entry) => {
        conversation = updateRealtimeTalkConversation(conversation, entry);
        onTranscript?.(entry);
      },
    },
    { transport: "webrtc" },
  );
  onTestFinished(() => session.stop());
  return {
    session,
    request,
    requests,
    onStatus,
    onTalkEvent,
    entries: () => conversation.entries.map(({ role, text }) => ({ role, text })),
    writes: () => requests.filter(({ method }) => method === "talk.client.transcript"),
  };
}

async function start() {
  const call = createCall();
  await call.session.start();
  return { ...call, peer: Peer.instances.at(-1)! };
}

describe("browser Talk provider item ordering", () => {
  beforeEach(() => {
    Peer.instances = [];
    Peer.setupBlock = undefined;
    vi.stubGlobal("RTCPeerConnection", Peer);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["ready", "stop", "replacement", "failure"])(
    "owns early provider items during SDP setup through %s",
    async (outcome) => {
      const setup = createDeferred();
      Peer.setupBlock = () => setup.promise;
      const call = createCall();
      const starting = call.session.start();
      const settled = starting.catch((error: unknown) => error);
      await waitForFast(() => expect(Peer.instances[0]?.setRemoteDescription).toHaveBeenCalled());
      const peer = Peer.instances[0]!;
      item(peer, "early-answer", "assistant", "early-user");
      final(peer, "early-answer", "assistant", "answer during setup");
      item(peer, "early-user", "user", null);
      if (outcome === "ready") {
        setup.resolve();
        await starting;
        final(peer, "early-user", "user", "question after setup");
        await waitForFast(() => expect(call.writes()).toHaveLength(2));
        expect(call.writes().map(({ params }) => params.text)).toEqual([
          "question after setup",
          "answer during setup",
        ]);
        call.session.stop();
      } else {
        if (outcome === "failure") {
          setup.reject(new Error("SDP rejected"));
          expect(await settled).toEqual(new Error("SDP rejected"));
        } else {
          if (outcome === "replacement") {
            Peer.setupBlock = undefined;
            await call.session.start();
          } else {
            call.session.stop();
          }
          setup.resolve();
          await starting;
        }
        await waitForFast(() => expect(call.writes()).toHaveLength(1));
        expect(call.writes()[0]?.params).toMatchObject({
          voiceSessionId: "voice-1",
          text: "answer during setup",
        });
        final(peer, "early-user", "user", "retired question");
        expect(call.writes()).toHaveLength(1);
      }
      await waitForFast(() =>
        expect(
          call.requests.filter(
            ({ method, params }) =>
              method === "talk.client.close" && params.voiceSessionId === "voice-1",
          ),
        ).toHaveLength(1),
      );
    },
  );

  it("streams immediately but persists a long utterance before its earlier-arriving reply", async () => {
    const call = await start();
    emit(call.peer, { type: "input_audio_buffer.speech_started", item_id: "u1" });
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    item(call.peer, "u1", "user", null);
    item(call.peer, "a1", "assistant", "u1");
    emit(call.peer, {
      type: "response.output_audio_transcript.delta",
      item_id: "a1",
      delta: "answer",
    });
    expect(call.entries()).toEqual([{ role: "assistant", text: "answer" }]);
    final(call.peer, "a1", "assistant", "answer");
    expect(call.writes()).toEqual([]);
    final(call.peer, "u1", "user", "a long question");
    await waitForFast(() => expect(call.writes()).toHaveLength(2));
    expect(call.writes().map(({ params }) => [params.role, params.text])).toEqual([
      ["user", "a long question"],
      ["assistant", "answer"],
    ]);
    expect(call.entries()).toEqual([
      { role: "user", text: "a long question" },
      { role: "assistant", text: "answer" },
    ]);
    call.session.stop();
  });

  it("keeps overlapping turns and identical speech tied to their exact items", async () => {
    const call = await start();
    item(call.peer, "u1", "user", null);
    item(call.peer, "a1", "assistant", "u1");
    item(call.peer, "u2", "user", "a1");
    item(call.peer, "a2", "assistant", "u2");
    final(call.peer, "a2", "assistant", "second answer");
    final(call.peer, "u2", "user", "yes");
    final(call.peer, "a1", "assistant", "first answer");
    final(call.peer, "u1", "user", "yes");
    await waitForFast(() => expect(call.writes()).toHaveLength(4));
    expect(call.writes().map(({ params }) => params.text)).toEqual([
      "yes",
      "first answer",
      "yes",
      "second answer",
    ]);
    expect(call.entries().map(({ text }) => text)).toEqual([
      "yes",
      "first answer",
      "yes",
      "second answer",
    ]);
    call.session.stop();
  });

  it.each(["speech", "non-speech"])(
    "connects an early successor through a late %s predecessor without delaying streaming",
    async (predecessor) => {
      const call = await start();
      item(call.peer, "a2", "assistant", "middle");
      emit(call.peer, {
        type: "response.output_audio_transcript.delta",
        item_id: "a2",
        delta: "second answer",
      });
      expect(call.peer.close).not.toHaveBeenCalled();
      expect(call.entries()).toEqual([{ role: "assistant", text: "second answer" }]);
      final(call.peer, "a2", "assistant", "second answer");
      item(call.peer, "u1", "user", null);
      item(call.peer, "a1", "assistant", "u1");
      final(call.peer, "a1", "assistant", "first answer");
      final(call.peer, "u1", "user", "first question");
      await waitForFast(() => expect(call.writes()).toHaveLength(2));
      emit(call.peer, {
        type: "conversation.item.added",
        previous_item_id: "a1",
        item:
          predecessor === "speech"
            ? { id: "middle", type: "message", role: "user", content: [{ type: "input_audio" }] }
            : { id: "middle", type: "function_call_output" },
      });
      // Metadata alone must move a previously streamed row into its known order.
      expect(call.entries().map(({ text }) => text)).toEqual([
        "first question",
        "first answer",
        "second answer",
      ]);
      if (predecessor === "speech") {
        expect(call.writes()).toHaveLength(2);
        final(call.peer, "middle", "user", "second question");
      }
      const expected = [
        "first question",
        "first answer",
        ...(predecessor === "speech" ? ["second question"] : []),
        "second answer",
      ];
      await waitForFast(() =>
        expect(call.writes().map(({ params }) => params.text)).toEqual(expected),
      );
      expect(call.entries().map(({ text }) => text)).toEqual(expected);
      expect(call.peer.close).not.toHaveBeenCalled();
    },
  );

  it("drains a known successor when its predecessor never arrives before stop", async () => {
    const call = await start();
    item(call.peer, "a2", "assistant", "a1");
    final(call.peer, "a2", "assistant", "next answer");
    item(call.peer, "a1", "assistant", "missing-user");
    final(call.peer, "a1", "assistant", "known answer");
    expect(call.peer.close).not.toHaveBeenCalled();
    expect(call.writes()).toEqual([]);
    call.session.stop();
    await waitForFast(() => expect(call.requests.at(-1)?.method).toBe("talk.client.close"));
    expect(call.writes().map(({ params }) => params.text)).toEqual(["known answer", "next answer"]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("unfinished transcript"));
    item(call.peer, "missing-user", "user", null);
    final(call.peer, "missing-user", "user", "too late");
    expect(call.writes()).toHaveLength(2);
    expect(call.requests.filter(({ method }) => method === "talk.client.close")).toHaveLength(1);
  });

  it("reports a failed predecessor save while its accepted successor still awaits ASR", async () => {
    const call = await start();
    const error = new Error("transcript store unavailable");
    call.request
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error);
    vi.useFakeTimers();
    item(call.peer, "u2", "user", "u1");
    item(call.peer, "u1", "user", null);
    final(call.peer, "u1", "user", "first question");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(call.onStatus).toHaveBeenLastCalledWith(
      "error",
      "Voice transcript could not be saved: transcript store unavailable",
    );
    expect(call.peer.close).not.toHaveBeenCalled();
    vi.useRealTimers();
    final(call.peer, "u2", "user", "second question");
    call.session.stop();
    await waitForFast(() => expect(call.requests.at(-1)?.method).toBe("talk.client.close"));
    expect(call.writes().map(({ params }) => params.text)).toEqual(["second question"]);
    expect(call.onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(1);
  });

  it("keeps a consult flush bound to the accepted successor while its predecessor arrives", async () => {
    const call = await start();
    item(call.peer, "a1", "assistant", "u1");
    final(call.peer, "a1", "assistant", "answer");
    emit(call.peer, {
      type: "response.done",
      response: {
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "consult-1",
            name: "openclaw_agent_consult",
            arguments: JSON.stringify({ question: "check status" }),
          },
        ],
      },
    });
    item(call.peer, "u1", "user", null);
    final(call.peer, "u1", "user", "question");
    await waitForFast(() =>
      expect(call.requests.some(({ method }) => method === "talk.client.toolCall")).toBe(true),
    );
    expect(
      call.requests
        .filter(({ method }) => method !== "talk.client.create")
        .map(({ method }) => method),
    ).toEqual(["talk.client.transcript", "talk.client.transcript", "talk.client.toolCall"]);
  });

  it.each(["failed", "empty"])(
    "settles %s ASR without inventing text or blocking its reply",
    async (outcome) => {
      const call = await start();
      item(call.peer, "u1", "user", null);
      item(call.peer, "a1", "assistant", "u1");
      final(call.peer, "a1", "assistant", "heard you");
      expect(call.writes()).toEqual([]);
      if (outcome === "failed") {
        emit(call.peer, {
          type: "conversation.item.input_audio_transcription.failed",
          item_id: "u1",
          error: { message: "speech decoder failed" },
        });
        expect(call.onStatus).toHaveBeenLastCalledWith("error", "speech decoder failed");
        expect(call.onTalkEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "session.error",
            itemId: "u1",
            payload: { message: "speech decoder failed" },
          }),
        );
      } else {
        final(call.peer, "u1", "user", "");
      }
      await waitForFast(() => expect(call.writes()).toHaveLength(1));
      expect(call.writes()[0]?.params.text).toBe("heard you");
      expect(call.peer.close).not.toHaveBeenCalled();
      item(call.peer, "u2", "user", "a1");
      final(call.peer, "u2", "user", "next question");
      await waitForFast(() => expect(call.writes()).toHaveLength(2));
      call.session.stop();
    },
  );

  it("deduplicates commit announcements and follows non-speech conversation links", async () => {
    const call = await start();
    emit(call.peer, {
      type: "input_audio_buffer.committed",
      item_id: "u1",
      previous_item_id: null,
    });
    item(call.peer, "u1", "user", null);
    emit(call.peer, {
      type: "conversation.item.added",
      previous_item_id: "u1",
      item: { id: "tool", type: "function_call" },
    });
    emit(call.peer, {
      type: "conversation.item.added",
      previous_item_id: "tool",
      item: { id: "tool-result", type: "function_call_output" },
    });
    emit(call.peer, {
      type: "conversation.item.added",
      previous_item_id: "tool-result",
      item: {
        id: "control-text",
        type: "message",
        role: "user",
        content: [{ type: "input_text" }],
      },
    });
    item(call.peer, "a1", "assistant", "control-text");
    final(call.peer, "a1", "assistant", "answer");
    final(call.peer, "u1", "user", "question");
    final(call.peer, "u1", "user", "duplicate must not replace question");
    await waitForFast(() => expect(call.writes()).toHaveLength(2));
    expect(call.writes().map(({ params }) => [params.entryId, params.text])).toEqual([
      ["1", "question"],
      ["2", "answer"],
    ]);
    expect(call.entries().map(({ text }) => text)).toEqual(["question", "answer"]);
  });

  it("releases an assistant item cancelled before it produced any text", async () => {
    const call = await start();
    item(call.peer, "u1", "user", null);
    item(call.peer, "cancelled-answer", "assistant", "u1");
    final(call.peer, "u1", "user", "first question");
    emit(call.peer, {
      type: "response.output_item.done",
      item: {
        id: "cancelled-answer",
        type: "message",
        role: "assistant",
        status: "incomplete",
        content: [],
      },
    });
    item(call.peer, "u2", "user", "cancelled-answer");
    final(call.peer, "u2", "user", "next question");
    await waitForFast(() => expect(call.writes()).toHaveLength(2));
    expect(call.writes().map(({ params }) => params.text)).toEqual([
      "first question",
      "next question",
    ]);
  });

  it.each([null, "missing-root"])(
    "bounds pending items with predecessor %s and drains accepted finals on overflow",
    async (previous) => {
      const call = await start();
      item(call.peer, "u1", "user", previous);
      for (let index = 0; index < 40; index += 1) {
        item(call.peer, `a${index}`, "assistant", index === 0 ? "u1" : `a${index - 1}`);
        final(call.peer, `a${index}`, "assistant", `answer-${index}`);
      }
      expect(call.writes()).toEqual([]);
      item(call.peer, "overflow", "user", "a39");
      expect(call.onStatus).toHaveBeenLastCalledWith(
        "error",
        expect.stringContaining("could not keep up"),
      );
      await waitForFast(() => expect(call.requests.at(-1)?.method).toBe("talk.client.close"));
      expect(call.writes().map(({ params }) => params.text)).toEqual(
        Array.from({ length: 40 }, (_, index) => `answer-${index}`),
      );
      final(call.peer, "u1", "user", "too late");
      expect(call.writes()).toHaveLength(40);
    },
  );

  it("persists a keyed final before a consumer synchronously stops the call", async () => {
    const call = createCall((entry) => {
      if (entry.final) {
        call.session.stop();
      }
    });
    await call.session.start();
    const peer = Peer.instances[0]!;
    item(peer, "u1", "user", null);
    item(peer, "a1", "assistant", "u1");
    final(peer, "a1", "assistant", "known before callback");
    await waitForFast(() => expect(call.requests.at(-1)?.method).toBe("talk.client.close"));
    expect(call.writes().map(({ params }) => params.text)).toEqual(["known before callback"]);
    expect(call.requests.filter(({ method }) => method === "talk.client.close")).toHaveLength(1);
    final(peer, "u1", "user", "late after callback");
    expect(call.writes()).toHaveLength(1);
  });

  it("drains known finals before close when an earlier ASR item never finishes", async () => {
    const call = await start();
    item(call.peer, "u1", "user", null);
    item(call.peer, "a1", "assistant", "u1");
    final(call.peer, "a1", "assistant", "known answer");
    expect(call.writes()).toEqual([]);
    call.session.stop();
    await waitForFast(() => expect(call.requests.at(-1)?.method).toBe("talk.client.close"));
    expect(
      call.requests
        .filter(({ method }) => method !== "talk.client.create")
        .map(({ method }) => method),
    ).toEqual(["talk.client.transcript", "talk.client.close"]);
    expect(call.writes()[0]?.params.text).toBe("known answer");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("unfinished transcript"));
    final(call.peer, "u1", "user", "too late");
    expect(call.writes()).toHaveLength(1);
  });
});
