import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
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
