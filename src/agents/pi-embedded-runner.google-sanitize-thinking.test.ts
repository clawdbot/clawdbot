import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { sanitizeSessionHistory } from "./pi-embedded-runner/google.js";

describe("sanitizeSessionHistory (google thinking)", () => {
  it("keeps thinking blocks without signatures for Google models", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning" }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      sessionManager,
      sessionId: "session:google",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string; thinking?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking"]);
    expect(assistant.content?.[0]?.thinking).toBe("reasoning");
  });

  it("keeps thinking blocks with signatures for Google models", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig" }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      sessionManager,
      sessionId: "session:google",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string; thinking?: string; thinkingSignature?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking"]);
    expect(assistant.content?.[0]?.thinking).toBe("reasoning");
    expect(assistant.content?.[0]?.thinkingSignature).toBe("sig");
  });

  it("keeps thinking blocks with Anthropic-style signatures for Google models", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning", signature: "sig" }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      sessionManager,
      sessionId: "session:google",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string; thinking?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking"]);
    expect(assistant.content?.[0]?.thinking).toBe("reasoning");
  });

  it("drops unsigned thinking blocks for Antigravity Claude", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning" }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      modelId: "anthropic/claude-3.5-sonnet",
      sessionManager,
      sessionId: "session:antigravity-claude",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant");
    expect(assistant).toBeUndefined();
  });

  it("maps base64 signatures to thinkingSignature for Antigravity Claude", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning", signature: "c2ln" }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      modelId: "anthropic/claude-3.5-sonnet",
      sessionManager,
      sessionId: "session:antigravity-claude",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string; thinking?: string; thinkingSignature?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking"]);
    expect(assistant.content?.[0]?.thinking).toBe("reasoning");
    expect(assistant.content?.[0]?.thinkingSignature).toBe("c2ln");
  });

  it("preserves order for mixed assistant content", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "internal note" },
          { type: "text", text: "world" },
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      sessionManager,
      sessionId: "session:google-mixed",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string; text?: string; thinking?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["text", "thinking", "text"]);
    expect(assistant.content?.[1]?.thinking).toBe("internal note");
  });

  it("strips non-base64 thought signatures for OpenRouter Gemini", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello", thought_signature: "msg_abc123" },
          { type: "thinking", thinking: "ok", thought_signature: "c2ln" },
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            arguments: { path: "/tmp/foo" },
            thoughtSignature: '{"id":1}',
          },
          {
            type: "toolCall",
            id: "call_2",
            name: "read",
            arguments: { path: "/tmp/bar" },
            thoughtSignature: "c2ln",
          },
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "openrouter",
      provider: "openrouter",
      modelId: "google/gemini-1.5-pro",
      sessionManager,
      sessionId: "session:openrouter-gemini",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{
        type?: string;
        thought_signature?: string;
        thoughtSignature?: string;
        thinking?: string;
      }>;
    };
    expect(assistant.content).toEqual([
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "ok", thought_signature: "c2ln" },
      {
        type: "toolCall",
        id: "call_1",
        name: "read",
        arguments: { path: "/tmp/foo" },
      },
      {
        type: "toolCall",
        id: "call_2",
        name: "read",
        arguments: { path: "/tmp/bar" },
        thoughtSignature: "c2ln",
      },
    ]);
  });

  it("keeps mixed signed/unsigned thinking blocks for Google models", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "signed", thinkingSignature: "sig" },
          { type: "thinking", thinking: "unsigned" },
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      sessionManager,
      sessionId: "session:google-mixed-signatures",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string; thinking?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking", "thinking"]);
    expect(assistant.content?.[0]?.thinking).toBe("signed");
    expect(assistant.content?.[1]?.thinking).toBe("unsigned");
  });

  it("keeps empty thinking blocks for Google models", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "   " }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      sessionManager,
      sessionId: "session:google-empty",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string; thinking?: string }>;
    };
    expect(assistant?.content?.map((block) => block.type)).toEqual(["thinking"]);
  });

  it("keeps thinking blocks for non-Google models", async () => {
    const sessionManager = SessionManager.inMemory();
    const input = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning" }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "openai",
      sessionManager,
      sessionId: "session:openai",
    });

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant") as {
      content?: Array<{ type?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking"]);
  });

  it("sanitizes tool call ids for Google APIs", async () => {
    const sessionManager = SessionManager.inMemory();
    const longId = `call_${"a".repeat(60)}`;
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: longId, name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: longId,
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionHistory({
      messages: input,
      modelApi: "google-antigravity",
      sessionManager,
      sessionId: "session:google",
    });

    const assistant = out.find(
      (msg) => (msg as { role?: unknown }).role === "assistant",
    ) as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.[0] as { id?: string };
    expect(toolCall.id).toBeDefined();
    expect(toolCall.id?.length).toBeLessThanOrEqual(40);

    const toolResult = out.find(
      (msg) => (msg as { role?: unknown }).role === "toolResult",
    ) as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.toolCallId).toBe(toolCall.id);
  });
});
