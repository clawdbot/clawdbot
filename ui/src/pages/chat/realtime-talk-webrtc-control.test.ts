// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../src/talk/describe-view-tool.js";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
} from "./realtime-talk-shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
  });
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = "new";
  readonly channel = new FakeDataChannel();
  readonly addTrack = vi.fn();
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  close(): void {
    this.connectionState = "closed";
  }
}

function createOpenAiTransport(
  client: Record<string, unknown>,
  callbacks: Record<string, unknown> = {},
): WebRtcSdpRealtimeTalkTransport {
  return new WebRtcSdpRealtimeTalkTransport(
    {
      provider: "openai",
      transport: "webrtc",
      clientSecret: "client-secret-123",
    },
    {
      client: client as never,
      sessionKey: "main",
      callbacks: callbacks as never,
    },
  );
}

function dispatchControlToolCall(
  peer: FakePeerConnection | undefined,
  args: { text: string; mode: "status" | "steer" },
): void {
  dispatchCompletedToolCall(peer, {
    name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
    arguments: JSON.stringify(args),
  });
}

function dispatchCompletedToolCall(
  peer: FakePeerConnection | undefined,
  overrides: {
    responseId?: string | null;
    responseStatus?: string | null;
    itemId?: string | null;
    itemStatus?: string | null;
    callId?: string | null;
    name?: string | null;
    arguments?: string | null;
  } = {},
): void {
  const field = (value: string | null | undefined, fallback: string): string | undefined =>
    value === undefined ? fallback : (value ?? undefined);
  peer?.channel.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "response.done",
        response: {
          id: field(overrides.responseId, "response-1"),
          status: field(overrides.responseStatus, "completed"),
          output: [
            {
              type: "function_call",
              id: field(overrides.itemId, "item-control"),
              status: field(overrides.itemStatus, "completed"),
              call_id: field(overrides.callId, "call-control"),
              name: field(overrides.name, REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME),
              arguments: field(overrides.arguments, JSON.stringify({ text: "status" })),
            },
          ],
        },
      }),
    }),
  );
}

function sentRealtimeEvents(peer: FakePeerConnection | undefined): Array<Record<string, unknown>> {
  return (
    peer?.channel.send.mock.calls.map(
      ([payload]) => JSON.parse(String(payload)) as Record<string, unknown>,
    ) ?? []
  );
}

describe("WebRtcSdpRealtimeTalkTransport control tool", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => stream),
      },
    });
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits semantic realtime control tool results through the OpenAI data channel", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "steer",
          sessionKey: "main",
          active: true,
          queued: true,
          message: "Got it. I steered the active run.",
          speak: true,
          show: true,
          suppress: false,
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createOpenAiTransport({
      addEventListener: vi.fn(() => () => undefined),
      request,
    });

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    dispatchControlToolCall(peer, { text: "revísalo en WebUI", mode: "steer" });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", {
        sessionKey: "main",
        text: "revísalo en WebUI",
        mode: "steer",
      }),
    );
    const sent =
      peer?.channel.send.mock.calls.map(([payload]) => JSON.parse(String(payload))) ?? [];
    expect(sent).toContainEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-control",
        output: expect.stringContaining('"mode":"steer"'),
      },
    });
    transport.stop();
  });

  it("executes completed calls once and ignores provisional events", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createOpenAiTransport({
      addEventListener: vi.fn(() => () => undefined),
      request,
    });

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    for (const type of [
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
    ]) {
      peer?.channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type,
            item_id: "item-1",
            call_id: "call-1",
            name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
            arguments: JSON.stringify({ question: "provisional" }),
            delta: JSON.stringify({ question: "provisional" }),
          }),
        }),
      );
    }
    expect(request).not.toHaveBeenCalled();

    dispatchCompletedToolCall(peer, {
      itemId: "item-1",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      arguments: JSON.stringify({ question: "status?" }),
    });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.toolCall", {
        sessionKey: "main",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      }),
    );

    dispatchCompletedToolCall(peer, {
      responseId: "response-2",
      itemId: "item-2",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      arguments: JSON.stringify({ question: "late" }),
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(request).toHaveBeenCalledTimes(1);
    transport.stop();
  });

  it.each([
    { label: "cancelled response", responseStatus: "cancelled", itemStatus: "completed" },
    { label: "failed response", responseStatus: "failed", itemStatus: "completed" },
    { label: "incomplete response", responseStatus: "incomplete", itemStatus: "completed" },
    { label: "incomplete item", responseStatus: "completed", itemStatus: "incomplete" },
  ])("ignores function calls from a $label", async ({ responseStatus, itemStatus }) => {
    const request = vi.fn();
    const transport = createOpenAiTransport({ request });

    await transport.start();
    dispatchCompletedToolCall(FakePeerConnection.instances[0], {
      responseStatus,
      itemStatus,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(request).not.toHaveBeenCalled();
    transport.stop();
  });

  it("accepts completed calls without optional response and item ids", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.steer") {
        return { ok: true, mode: "status" };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createOpenAiTransport({ request });

    await transport.start();
    dispatchCompletedToolCall(FakePeerConnection.instances[0], {
      responseId: null,
      itemId: null,
    });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", {
        sessionKey: "main",
        text: "status",
        mode: "status",
      }),
    );

    transport.stop();
  });

  it("requires call, name, and arguments before executing tools", async () => {
    const request = vi.fn();
    const transport = createOpenAiTransport({ request });

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    for (const overrides of [
      { callId: null, itemId: "missing-call" },
      { name: null, callId: "missing-name", itemId: "missing-name" },
      { arguments: null, callId: "missing-args", itemId: "missing-args" },
    ]) {
      dispatchCompletedToolCall(peer, overrides);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(request).not.toHaveBeenCalled();
    transport.stop();
  });

  it("enforces the authoritative 256000-byte UTF-8 argument limit", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.steer") {
        return { ok: true, mode: "status" };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const onTalkEvent = vi.fn();
    const transport = createOpenAiTransport({ request }, { onTalkEvent });
    const baseArgs = JSON.stringify({ text: "status" });
    const argumentsAtLimit = baseArgs + " ".repeat(256_000 - baseArgs.length);
    const oversizedArguments = JSON.stringify({ text: "é".repeat(128_000) });

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    dispatchCompletedToolCall(peer, { arguments: argumentsAtLimit });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    dispatchCompletedToolCall(peer, {
      responseId: "response-2",
      itemId: "item-2",
      callId: "call-2",
      arguments: oversizedArguments,
    });
    dispatchCompletedToolCall(peer, {
      responseId: "response-3",
      itemId: "item-3",
      callId: "call-2",
      arguments: oversizedArguments,
    });

    expect(new TextEncoder().encode(argumentsAtLimit)).toHaveLength(256_000);
    expect(new TextEncoder().encode(oversizedArguments).byteLength).toBeGreaterThan(256_000);
    const outputs = sentRealtimeEvents(peer).filter(
      (event) =>
        event.type === "conversation.item.create" &&
        (event.item as { type?: string } | undefined)?.type === "function_call_output",
    );
    expect(outputs).toHaveLength(2);
    expect(
      JSON.parse(String((outputs[1]?.item as { output?: string } | undefined)?.output)),
    ).toEqual({
      error: "Realtime tool arguments exceed the 256000-byte UTF-8 limit",
    });
    expect(onTalkEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool.error",
        callId: "call-2",
        itemId: "item-2",
        final: true,
      }),
    );
    transport.stop();
  });

  it("ends the session instead of evicting completed call identities", async () => {
    const onStatus = vi.fn();
    const transport = createOpenAiTransport({}, { onStatus });

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    for (let index = 0; index < 1_024; index += 1) {
      dispatchCompletedToolCall(peer, {
        responseId: `response-${index}`,
        itemId: `item-${index}`,
        callId: `call-${index}`,
        name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
        arguments: "{}",
      });
    }
    dispatchCompletedToolCall(peer, {
      responseId: "response-overflow",
      itemId: "item-overflow",
      callId: "call-overflow",
      name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
      arguments: "{}",
    });

    expect(onStatus).toHaveBeenCalledWith("error", "Realtime tool-call session limit exceeded");
    expect(peer?.channel.close).toHaveBeenCalledOnce();
    dispatchCompletedToolCall(peer, {
      responseId: "response-late",
      itemId: "item-late",
      callId: "call-late",
      name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
      arguments: "{}",
    });
    expect(peer?.channel.close).toHaveBeenCalledOnce();
  });

  it("surfaces OpenAI tool-result send failures without an unhandled rejection", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "status",
          sessionKey: "main",
          active: true,
          message: "Still working.",
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createOpenAiTransport({ request }, { onStatus, onTalkEvent });

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    peer?.channel.send.mockImplementation(() => {
      throw new Error("OpenAI data channel rejected the tool result");
    });
    dispatchControlToolCall(peer, { text: "status", mode: "status" });

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "OpenAI data channel rejected the tool result",
      ),
    );
    expect(
      onTalkEvent.mock.calls.some(
        ([event]) =>
          (event.type === "tool.progress" || event.type === "tool.error") && event.final === true,
      ),
    ).toBe(false);
    transport.stop();
  });

  it("silently disposes a provisional OpenAI transport", async () => {
    const onTalkEvent = vi.fn();
    const transport = createOpenAiTransport({}, { onTalkEvent });
    await transport.start();
    onTalkEvent.mockClear();

    transport.stop({ emitClosed: false });

    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(FakePeerConnection.instances[0]?.connectionState).toBe("closed");
  });

  it("stops an assistant turn event when its transcript callback closes the transport", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transportRef: { current?: WebRtcSdpRealtimeTalkTransport } = {};
    const onTranscript = vi.fn(() => transportRef.current?.stop());
    const transport = createOpenAiTransport({}, { onStatus, onTalkEvent, onTranscript });
    transportRef.current = transport;
    await transport.start();
    onStatus.mockClear();
    onTalkEvent.mockClear();

    FakePeerConnection.instances[0]?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "turn.done",
          turn: { id: "assistant-final", role: "assistant", transcript: "finished" },
        }),
      }),
    );

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onStatus).not.toHaveBeenCalled();
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(["session.closed"]);
  });
});
