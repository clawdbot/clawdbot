import { afterEach, describe, expect, it, vi } from "vitest";
import { testing, registerNativeHookRelay } from "../../agents/harness/native-hook-relay.js";
import { nativeHookRelayHandlers } from "./native-hook-relay.js";

afterEach(() => {
  testing.clearNativeHookRelaysForTests();
});

describe("native hook relay gateway method", () => {
  it("accepts a live relay invocation", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    const respond = viRespond();

    await nativeHookRelayHandlers["nativeHook.invoke"]({
      req: { type: "req", id: "1", method: "nativeHook.invoke" },
      params: {
        provider: "codex",
        relayId: relay.relayId,
        generation: relay.generation,
        event: "post_tool_use",
        rawPayload: {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_response: { output: "ok" },
        },
      },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(true, { stdout: "", stderr: "", exitCode: 0 });
    expect(testing.getNativeHookRelayInvocationsForTests()).toHaveLength(1);
  });

  it("rejects unknown relay ids", async () => {
    const respond = viRespond();

    await nativeHookRelayHandlers["nativeHook.invoke"]({
      req: { type: "req", id: "1", method: "nativeHook.invoke" },
      params: {
        provider: "codex",
        relayId: "missing",
        event: "pre_tool_use",
        rawPayload: {},
      },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    const call = respond.mock.calls.at(0) as
      | [boolean, unknown, { code?: string; message?: string }]
      | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[1]).toBeUndefined();
    expect(call?.[2]?.code).toBe("INVALID_REQUEST");
    expect(call?.[2]?.message).toContain("not found");
  });

  it("rejects stale relay generations", async () => {
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId: "relay-1",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    registerNativeHookRelay({
      provider: "codex",
      relayId: first.relayId,
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });
    const respond = viRespond();

    await nativeHookRelayHandlers["nativeHook.invoke"]({
      req: { type: "req", id: "1", method: "nativeHook.invoke" },
      params: {
        provider: "codex",
        relayId: first.relayId,
        generation: first.generation,
        event: "post_tool_use",
        rawPayload: {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_response: { output: "ok" },
        },
      },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    const call = respond.mock.calls.at(0) as
      | [boolean, unknown, { code?: string; message?: string }]
      | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[1]).toBeUndefined();
    expect(call?.[2]?.code).toBe("INVALID_REQUEST");
    expect(call?.[2]?.message).toContain("native hook relay bridge stale registration");
    expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
  });
});

function viRespond() {
  return vi.fn();
}
