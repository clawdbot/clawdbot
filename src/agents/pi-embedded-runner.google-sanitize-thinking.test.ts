import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { sanitizeSessionHistory } from "./pi-embedded-runner/google.js";

describe("sanitizeSessionHistory (google thinking)", () => {
  it("downgrades thinking blocks without signatures for Google models", async () => {
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
      content?: Array<{ type?: string; text?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["text"]);
    expect(assistant.content?.[0]?.text).toBe("reasoning");
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

  it("preserves order when downgrading mixed assistant content", async () => {
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
      content?: Array<{ type?: string; text?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["text", "text", "text"]);
    expect(assistant.content?.[1]?.text).toBe("internal note");
  });

  it("downgrades only unsigned thinking blocks when mixed with signed ones", async () => {
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
      content?: Array<{ type?: string; thinking?: string; text?: string }>;
    };
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking", "text"]);
    expect(assistant.content?.[0]?.thinking).toBe("signed");
    expect(assistant.content?.[1]?.text).toBe("unsigned");
  });

  it("drops empty unsigned thinking blocks for Google models", async () => {
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

    const assistant = out.find((msg) => (msg as { role?: string }).role === "assistant");
    expect(assistant).toBeUndefined();
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

  it("sanitizes tool call ids for OpenAI-compatible APIs", async () => {
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
      modelApi: "openai-responses",
      sessionManager,
      sessionId: "session:openai",
    });

    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content?.[0] as { id?: string };
    expect(toolCall.id).toBeDefined();
    expect(toolCall.id?.length).toBeLessThanOrEqual(40);

    const toolResult = out[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.toolCallId).toBe(toolCall.id);
  });
});
