import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, registerNativeHookRelay } from "../../agents/harness/native-hook-relay.js";
import { nativeHookRelayHandlers } from "./native-hook-relay.js";

afterEach(() => {
  __testing.clearNativeHookRelaysForTests();
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
    expect(__testing.getNativeHookRelayInvocationsForTests()).toHaveLength(1);
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

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("not found"),
      }),
    );
  });
});

function viRespond() {
  return vi.fn();
}
