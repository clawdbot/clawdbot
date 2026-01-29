import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { SecretScrubber } from "../security/scrubber.js";

describe("Scrubbing Integration", () => {
  it("redacts secrets in block replies", async () => {
    const onBlockReply = vi.fn();
    const mockSession = {
      subscribe: (h: any) => mockSession.subscribeImpl(h),
      subscribeImpl: vi.fn(),
      agent: {
        agentId: "test-agent",
      },
      sessionId: "test-session",
    } as unknown as AgentSession & { subscribeImpl: any };

    const secrets = new SecretScrubber(["super-secret-token-123"]);

    let handler: any;
    vi.mocked(mockSession.subscribeImpl).mockImplementation((h: any) => {
      handler = h;
      return () => {};
    });

    subscribeEmbeddedPiSession({
      session: mockSession as any,
      runId: "test-run",
      onBlockReply,
      secrets,
    });

    if (!handler) throw new Error("Handler not registered");

    const assistantMsg = { role: "assistant", content: "" } as any;

    // Simulate model outputting the secret
    handler({
      type: "message_update",
      message: assistantMsg,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "The token is super-secret-token-123.",
        partial: assistantMsg,
      } as any,
    });

    handler({
      type: "message_update",
      message: { role: "assistant", content: "The token is super-secret-token-123." } as any,
      assistantMessageEvent: {
        type: "text_end",
        content: "The token is super-secret-token-123.",
      } as any,
    });

    expect(onBlockReply).toHaveBeenCalled();
    const lastCall = onBlockReply.mock.calls[0][0];
    expect(lastCall.text).toContain("your-key-here");
    expect(lastCall.text).not.toContain("super-secret-token-123");
  });

  it("redacts secrets in tool results", async () => {
    const onToolResult = vi.fn();
    const mockSession = {
      subscribe: (h: any) => mockSession.subscribeImpl(h),
      subscribeImpl: vi.fn(),
    } as unknown as AgentSession & { subscribeImpl: any };

    const secrets = new SecretScrubber(["db-password-xyz"]);

    subscribeEmbeddedPiSession({
      session: mockSession as any,
      runId: "test-run",
      onToolResult,
      secrets,
      verboseLevel: "full",
    });

    const handler = vi.mocked(mockSession.subscribeImpl).mock.calls[0][0];

    // Simulate tool outputting a secret in the standardized format
    handler({
      type: "tool_execution_end",
      toolName: "read_file",
      toolCallId: "tool-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "password=db-password-xyz" }],
      },
    });

    expect(onToolResult).toHaveBeenCalled();
    const lastCall = onToolResult.mock.calls[0][0];
    expect(lastCall.text).toContain("your-key-here");
    expect(lastCall.text).not.toContain("db-password-xyz");
  });

  it("redacts secrets in reasoning streams", async () => {
    const onReasoningStream = vi.fn();
    const mockSession = {
      subscribe: (h: any) => mockSession.subscribeImpl(h),
      subscribeImpl: vi.fn(),
    } as unknown as AgentSession & { subscribeImpl: any };

    const secrets = new SecretScrubber(["reasoning-secret-123"]);

    subscribeEmbeddedPiSession({
      session: mockSession as any,
      runId: "test-run",
      onReasoningStream,
      secrets,
      reasoningMode: "stream",
    });

    const handler = vi.mocked(mockSession.subscribeImpl).mock.calls[0][0];

    const assistantMsg = { role: "assistant", content: "" } as any;

    // Simulate model outputting thinking tags
    handler({
      type: "message_update",
      message: assistantMsg,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "<think>My secret is reasoning-secret-123</think>",
        partial: assistantMsg,
      } as any,
    });

    expect(onReasoningStream).toHaveBeenCalled();
    const lastCall = onReasoningStream.mock.calls[0][0];
    expect(lastCall.text).toContain("your-key-here");
    expect(lastCall.text).not.toContain("reasoning-secret-123");
  });
});
