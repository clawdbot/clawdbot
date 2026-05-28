import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "./session-transcript-repair.js";

function assistantToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "n", arguments: {} }],
  } as AgentMessage;
}

describe("guardSessionManager integration", () => {
  it("persists synthetic toolResult before subsequent assistant message", () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(assistantToolCall("call_1"));
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "followup" }],
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    expect((messages[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(sanitizeToolUseResultPairing(messages).map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });

  it("keeps real toolResult pending across delivery-mirror assistant messages", () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(assistantToolCall("call_1"));
    appendMessage({
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "display copy" }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "n",
      content: [{ type: "text", text: "real output" }],
      isError: false,
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "assistant", "toolResult"]);
    expect((messages[1] as { model?: string }).model).toBe("delivery-mirror");
    expect((messages[2] as { isError?: boolean }).isError).toBe(false);
    expect((messages[2] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe(
      "real output",
    );
    expect(JSON.stringify(messages)).not.toContain("missing tool result");
  });

  it("uses Codex-style aborted synthetic results for interrupted Responses tool calls", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      allowSyntheticToolResults: true,
      missingToolResultText: "aborted",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(assistantToolCall("call_responses_1"));
    appendMessage({
      role: "user",
      content: [{ type: "text", text: "interrupting prompt" }],
      timestamp: Date.now(),
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "user"]);
    expect((messages[1] as { toolCallId?: string }).toolCallId).toBe("call_responses_1");
    expect((messages[1] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe(
      "aborted",
    );
  });

  it("applies prepared user persistence fields to the next real user message", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      preparedUserTurnMessage: {
        role: "user",
        content: "What is in this image?",
        timestamp: 123,
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png"],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      } as Extract<AgentMessage, { role: "user" }>,
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage({
      role: "user",
      content: [
        { type: "text", text: "[media attached: media://inbound/a.png]\nWhat is in this image?" },
      ],
    } as AgentMessage);
    appendMessage({ role: "user", content: "follow-up" } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages[0]).toMatchObject({
      role: "user",
      content: "What is in this image?",
      MediaPath: "/tmp/a.png",
      MediaPaths: ["/tmp/a.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
    expect(messages[1]).toEqual({ role: "user", content: "follow-up" });
  });

  it("does not consume prepared user persistence for before-agent-run blocked messages", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      preparedUserTurnMessage: {
        role: "user",
        content: "visible prompt",
        timestamp: 123,
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png"],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      } as Extract<AgentMessage, { role: "user" }>,
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage({
      role: "user",
      content: [{ type: "text", text: "blocked" }],
      timestamp: 124,
      __openclaw: { beforeAgentRunBlocked: { blockedBy: "test", blockedAt: 123 } },
    } as AgentMessage);
    appendMessage({ role: "user", content: "runtime prompt" } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "blocked" }],
      __openclaw: { beforeAgentRunBlocked: { blockedBy: "test", blockedAt: 123 } },
    });
    expect(messages[0]).not.toHaveProperty("MediaPath");
    expect(messages[1]).toMatchObject({
      role: "user",
      content: "visible prompt",
      MediaPath: "/tmp/a.png",
      MediaPaths: ["/tmp/a.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
  });

  it("redacts configured text patterns before persisting transcript messages", () => {
    const cfg = {
      logging: {
        redactSensitive: "tools",
        redactPatterns: [String.raw`([\w]|[-.])+@([\w]|[-.])+\.\w+`],
      },
    } satisfies OpenClawConfig;
    const sm = guardSessionManager(SessionManager.inMemory(), { config: cfg });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "the email is peter@dc.io", thinkingSignature: "sig" },
        { type: "text", text: "contact peter@dc.io" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp/peter@dc.io" } },
      ],
      stopReason: "toolUse",
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "peter@dc.io\n" }],
      isError: false,
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    const serialized = JSON.stringify(messages);

    expect(serialized).not.toContain("the email is peter@dc.io");
    expect(serialized).not.toContain("contact peter@dc.io");
    expect(serialized).not.toContain("peter@dc.io\\n");
    expect(serialized).not.toContain('"/tmp/peter@dc.io"');
    expect(serialized).toContain('"thinking":"the email is peter@d***.io"');
    expect(serialized).toContain('"text":"contact peter@d***.io"');
    expect(serialized).toContain('"text":"peter@d***.io\\n"');
    expect(serialized).toContain('"/tmp/peter@d***.io"');
  });
});
