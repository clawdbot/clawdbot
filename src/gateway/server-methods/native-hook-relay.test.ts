/**
 * Tests for relaying native hook events through gateway request handlers.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing, registerNativeHookRelay } from "../../agents/harness/native-hook-relay.js";
import { nativeHookRelayHandlers } from "./native-hook-relay.js";

const POST_TOOL_USE_PAYLOAD = {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_response: { output: "ok" },
};

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

    const respond = await invokeNativeHook({
      provider: "codex",
      relayId: relay.relayId,
      generation: relay.generation,
      event: "post_tool_use",
      rawPayload: POST_TOOL_USE_PAYLOAD,
    });

    expect(respond).toHaveBeenCalledWith(true, { stdout: "", stderr: "", exitCode: 0 });
    expect(testing.getNativeHookRelayInvocationsForTests()).toHaveLength(1);
  });

  it("rejects unknown relay ids", async () => {
    const respond = await invokeNativeHook({
      provider: "codex",
      relayId: "missing",
      event: "pre_tool_use",
      rawPayload: {},
    });

    expectInvalidRequest(respond, "not found");
  });

  it("binds gateway invocations to the registration that claimed the payload turn", async () => {
    // Same-generation overlap: the gateway path must honor the claimed turn id
    // instead of routing to the newest sibling's policy context.
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId: "relay-turn-claim",
      generation: "generation-thread-1",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    first.claimTurn("turn-1");
    const second = registerNativeHookRelay({
      provider: "codex",
      relayId: first.relayId,
      generation: "generation-thread-1",
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });
    second.claimTurn("turn-2");

    const respond = await invokeNativeHook({
      provider: "codex",
      relayId: first.relayId,
      generation: first.generation,
      event: "post_tool_use",
      rawPayload: { ...POST_TOOL_USE_PAYLOAD, turn_id: "turn-1" },
    });

    expect(respond).toHaveBeenCalledWith(true, { stdout: "", stderr: "", exitCode: 0 });
    expect(testing.getNativeHookRelayInvocationsForTests()).toMatchObject([{ runId: "run-1" }]);
  });

  it("rejects unclaimed hooks while live registrations contest one generation", async () => {
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId: "relay-contested",
      generation: "generation-thread-1",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    registerNativeHookRelay({
      provider: "codex",
      relayId: first.relayId,
      generation: "generation-thread-1",
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });

    const respond = await invokeNativeHook({
      provider: "codex",
      relayId: first.relayId,
      generation: first.generation,
      event: "post_tool_use",
      rawPayload: { ...POST_TOOL_USE_PAYLOAD, turn_id: "turn-unclaimed" },
    });

    expectInvalidRequest(respond, "native hook relay bridge stale registration");
    expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
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
    // Overlapping registrations keep both generations live; staleness begins
    // when a generation's own registration unregisters.
    first.unregister();

    const respond = await invokeNativeHook({
      provider: "codex",
      relayId: first.relayId,
      generation: first.generation,
      event: "post_tool_use",
      rawPayload: POST_TOOL_USE_PAYLOAD,
    });

    expectInvalidRequest(respond, "native hook relay bridge stale registration");
    expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
  });
});

async function invokeNativeHook(params: Record<string, unknown>) {
  const respond = viRespond();
  await expectDefined(
    nativeHookRelayHandlers["nativeHook.invoke"],
    'nativeHookRelayHandlers["nativeHook.invoke"] test invariant',
  )({
    req: { type: "req", id: "1", method: "nativeHook.invoke" },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  });
  return respond;
}

function expectInvalidRequest(respond: ReturnType<typeof viRespond>, message: string) {
  const call = respond.mock.calls.at(0) as
    | [boolean, unknown, { code?: string; message?: string }]
    | undefined;
  expect(call?.[0]).toBe(false);
  expect(call?.[1]).toBeUndefined();
  expect(call?.[2]?.code).toBe("INVALID_REQUEST");
  expect(call?.[2]?.message).toContain(message);
}

function viRespond() {
  return vi.fn();
}
