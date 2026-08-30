import { describe, expect, it, vi } from "vitest";
import {
  createClient,
  createSession,
  createTransport,
  encodeJsonFrame,
  flushMicrotasks,
  installGoogleLiveTestFixture,
  startTransport,
} from "./realtime-talk-google-live.test-support.ts";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";

describe("Google Live browser transcript finality", () => {
  installGoogleLiveTestFixture();

  it("finalizes both live 3.1 spoken turns before the session closes", async () => {
    const onTranscript = vi.fn();
    const transport = createTransport({ onTranscript });
    const ws = await startTransport(transport);
    for (const [input, output] of [
      ["Please reply with the single word glacier.", "Glacier."],
      ["Now reply with the single word crystal.", "Crystal."],
    ]) {
      for (const serverContent of [
        { inputTranscription: { text: input } },
        { outputTranscription: { text: output } },
        { generationComplete: true },
        { turnComplete: true },
      ]) {
        ws.emitMessage(encodeJsonFrame({ serverContent }));
        await flushMicrotasks();
      }
    }
    expect(onTranscript.mock.calls.map(([entry]) => entry).filter((entry) => entry.final)).toEqual([
      { role: "user", text: "Please reply with the single word glacier.", final: true },
      { role: "assistant", text: "Glacier.", final: true },
      { role: "user", text: "Now reply with the single word crystal.", final: true },
      { role: "assistant", text: "Crystal.", final: true },
    ]);
    transport.stop();
    expect(onTranscript.mock.calls.filter(([entry]) => entry.final)).toHaveLength(4);
  });

  it("accumulates 2.5 fragments and honors a finish-only message", async () => {
    const onTranscript = vi.fn();
    const transport = new GoogleLiveRealtimeTalkTransport(
      {
        ...createSession(
          "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
        ),
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
      },
      { callbacks: { onTranscript }, client: createClient(), sessionKey: "main" },
    );
    const ws = await startTransport(transport);
    for (const transcription of [{ text: "Last " }, { text: "words" }, { finished: true }]) {
      ws.emitMessage(encodeJsonFrame({ serverContent: { inputTranscription: transcription } }));
      await flushMicrotasks();
    }
    expect(onTranscript.mock.calls.map(([entry]) => entry)).toEqual([
      { role: "user", text: "Last ", final: false },
      { role: "user", text: "words", final: false },
      { role: "user", text: "Last words", final: true },
    ]);
    transport.stop();
  });

  it.each([
    {
      name: "before the next input transcript",
      boundary: [
        { interrupted: true },
        { turnComplete: true },
        { inputTranscription: { text: "New question" } },
      ],
    },
    {
      name: "after an independently ordered input transcript",
      boundary: [
        { interrupted: true },
        { inputTranscription: { text: "New question" } },
        { turnComplete: true },
      ],
    },
    {
      name: "in the interruption frame",
      boundary: [
        { interrupted: true, turnComplete: true },
        { inputTranscription: { text: "New question" } },
      ],
    },
  ])(
    "does not end another Talk turn when interrupted completion arrives $name",
    async ({ boundary }) => {
      const onTranscript = vi.fn();
      const onTalkEvent = vi.fn();
      const transport = createTransport({ onTranscript, onTalkEvent });
      const ws = await startTransport(transport);
      onTalkEvent.mockClear();
      for (const serverContent of [
        { outputTranscription: { text: "Interrupted " } },
        { outputTranscription: { text: "response" } },
        ...boundary,
        { outputTranscription: { text: "Next response", finished: true } },
        { turnComplete: true },
      ]) {
        ws.emitMessage(encodeJsonFrame({ serverContent }));
        await flushMicrotasks();
      }
      expect(
        onTranscript.mock.calls.filter(([entry]) => entry.final).map(([entry]) => entry.text),
      ).toEqual(["Interrupted response", "New question", "Next response"]);
      expect(onTalkEvent.mock.calls.map(([event]) => [event.type, event.turnId])).toEqual([
        ["output.text.delta", "turn-1"],
        ["output.text.delta", "turn-1"],
        ["output.text.done", "turn-1"],
        ["turn.cancelled", "turn-1"],
        ["transcript.done", "turn-2"],
        ["output.text.delta", "turn-2"],
        ["output.text.done", "turn-2"],
        ["turn.ended", "turn-2"],
      ]);
      transport.stop();
      expect(onTranscript.mock.calls.filter(([entry]) => entry.final)).toHaveLength(3);
    },
  );

  it("releases the UTF-8 transcript budget on finality and closes on overflow without persisting a partial", async () => {
    const onTranscript = vi.fn();
    const onStatus = vi.fn();
    const transport = createTransport({ onTranscript, onStatus });
    const ws = await startTransport(transport);
    const atLimit = "é".repeat(128 * 1024);
    for (const outputTranscription of [
      { text: atLimit },
      { finished: true },
      { text: atLimit },
      { text: "é" },
      { finished: true },
    ]) {
      ws.emitMessage(encodeJsonFrame({ serverContent: { outputTranscription } }));
      await flushMicrotasks();
    }
    expect(
      onTranscript.mock.calls.filter(([entry]) => entry.final).map(([entry]) => entry.text),
    ).toEqual([atLimit]);
    expect(onTranscript).toHaveBeenCalledTimes(3);
    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "Google Live transcript exceeded the 256 KiB UTF-8 pending buffer limit",
    );
    expect(ws.readyState).toBe(3);
  });
});
