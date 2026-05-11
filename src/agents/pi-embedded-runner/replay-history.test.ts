import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { normalizeAssistantReplayContent } from "./replay-history.js";

const FALLBACK_TEXT = "[assistant turn failed before producing content]";
const COPIED_INBOUND_METADATA_ONLY_TEXT = `Conversation info (untrusted metadata):
\`\`\`json
{"message_id":"msg-abc","sender":"+1555000"}
\`\`\``;

function bedrockAssistant(
  content: unknown,
  stopReason: "error" | "stop" | "toolUse" | "length" = "error",
  usageOverrides: Record<string, number> = {},
): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    model: "anthropic.claude-3-haiku-20240307-v1:0",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usageOverrides,
    },
    stopReason,
    timestamp: 0,
  } as unknown as AgentMessage;
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as unknown as AgentMessage;
}

function openclawTranscriptAssistant(model: "delivery-mirror" | "gateway-injected"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "channel mirror" }],
    api: "openai-responses",
    provider: "openclaw",
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as unknown as AgentMessage;
}

describe("normalizeAssistantReplayContent", () => {
  it("converts mid-turn assistant content: [] to a non-empty sentinel text block when stopReason is error", () => {
    const messages = [userMessage("hello"), bedrockAssistant([], "error"), userMessage("retry")];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).not.toBe(messages);
    const repaired = out[1] as AgentMessage & { content: { type: string; text: string }[] };
    expect(repaired.content).toEqual([{ type: "text", text: FALLBACK_TEXT }]);
    // Trailing user is preserved so request still ends with user.
    expect(out).toHaveLength(3);
    expect((out[2] as { role: string }).role).toBe("user");
  });

  it("drops blank user text messages from replay", () => {
    const messages = [
      userMessage("before"),
      {
        role: "user",
        content: [{ type: "text", text: "" }],
        timestamp: 0,
      } as unknown as AgentMessage,
      userMessage("after"),
    ];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).not.toBe(messages);
    expect(out).toEqual([messages[0], messages[2]]);
  });

  it("removes blank user text blocks while preserving non-text content", () => {
    const imageBlock = { type: "image", data: "AA==", mimeType: "image/png" };
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "   " }, imageBlock],
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).not.toBe(messages);
    expect((out[0] as { content: unknown[] }).content).toEqual([imageBlock]);
  });

  it("preserves nonzero-usage silent-reply turns (stopReason=stop, content=[]) untouched", () => {
    // run.empty-error-retry.test.ts treats `stopReason:"stop"` + `content:[]`
    // as a legitimate NO_REPLY / silent-reply, NOT a crash. Substituting the
    // failure sentinel here would inject a fabricated "[assistant turn failed
    // before producing content]" into the next provider request and change
    // model behavior even though no failure occurred.
    const silentStop = bedrockAssistant([], "stop", { input: 100, totalTokens: 100 });
    const messages = [userMessage("hello"), silentStop];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toBe(messages);
    expect(out[1]).toBe(silentStop);
  });

  it("converts mid-turn zero-usage empty stop turns to a replay sentinel", () => {
    const falseSuccessStop = bedrockAssistant([], "stop");
    const messages = [userMessage("hello"), falseSuccessStop, userMessage("retry")];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).not.toBe(messages);
    const repaired = out[1] as AgentMessage & { content: { type: string; text: string }[] };
    expect(repaired.content).toEqual([{ type: "text", text: FALLBACK_TEXT }]);
  });

  it("preserves empty content with non-error stopReasons (toolUse, length) untouched", () => {
    // Boundary lock: only `stopReason:"error"` should trip the sentinel
    // substitution. `toolUse` and `length` are reachable in practice when a
    // provider terminates a turn before a content block is emitted, and
    // rewriting them as a failure would lie about what happened.
    const toolUse = bedrockAssistant([], "toolUse");
    const length = bedrockAssistant([], "length");
    const messages = [userMessage("hello"), toolUse, length];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toBe(messages);
    expect(out[1]).toBe(toolUse);
    expect(out[2]).toBe(length);
  });

  it("wraps legacy string assistant content as a single text block (regression)", () => {
    const messages = [userMessage("hi"), bedrockAssistant("plain string content")];
    const out = normalizeAssistantReplayContent(messages);
    const wrapped = out[1] as AgentMessage & { content: { type: string; text: string }[] };
    expect(wrapped.content).toEqual([{ type: "text", text: "plain string content" }]);
  });

  it("drops metadata-only legacy string assistant content from replay", () => {
    const messages = [
      userMessage("first"),
      bedrockAssistant(COPIED_INBOUND_METADATA_ONLY_TEXT),
      userMessage("second"),
    ];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toEqual([messages[0], messages[2]]);
    expect(JSON.stringify(out)).not.toContain("assistant copied inbound metadata omitted");
  });

  it("drops metadata-only assistant text blocks without fabricating placeholder output", () => {
    const toolCall = { type: "toolCall", id: "call_1", name: "read", arguments: {} };
    const messages = [
      userMessage("hi"),
      bedrockAssistant([
        { type: "text", text: COPIED_INBOUND_METADATA_ONLY_TEXT },
        { type: "text", text: `${COPIED_INBOUND_METADATA_ONLY_TEXT}\n\nVisible reply` },
        toolCall,
      ]),
    ];
    const out = normalizeAssistantReplayContent(messages);
    const normalized = out[1] as AgentMessage & { content: unknown[] };
    expect(normalized.content).toEqual([{ type: "text", text: "Visible reply" }, toolCall]);
    expect(JSON.stringify(out)).not.toContain("assistant copied inbound metadata omitted");
  });

  it("filters openclaw delivery-mirror and gateway-injected assistant messages from replay", () => {
    const messages = [
      userMessage("hello"),
      openclawTranscriptAssistant("delivery-mirror"),
      bedrockAssistant([{ type: "text", text: "real reply" }]),
      openclawTranscriptAssistant("gateway-injected"),
    ];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toHaveLength(2);
    expect((out[0] as { role: string }).role).toBe("user");
    expect((out[1] as { provider: string }).provider).toBe("amazon-bedrock");
  });

  it("returns the original array reference when nothing needs to change", () => {
    const messages = [userMessage("hello"), bedrockAssistant([{ type: "text", text: "fine" }])];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toBe(messages);
  });

  it("drops a trailing assistant turn whose content: [] would have been rewritten to the sentinel (#77228)", () => {
    // The sentinel was synthesized to satisfy Bedrock's non-empty-content
    // rule for *non-trailing* error turns. As the trailing message it would
    // make prefill-strict providers (e.g. github-copilot/claude-opus-4.6)
    // 400 with "conversation must end with a user message". The original
    // turn carried content:[] and zero usage — drop is lossless.
    const messages = [userMessage("hello"), bedrockAssistant([], "error")];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).not.toBe(messages);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(messages[0]);
  });

  it("drops a trailing zero-usage empty stop assistant turn (#77228)", () => {
    const falseSuccessStop = bedrockAssistant([], "stop");
    const messages = [userMessage("hello"), falseSuccessStop];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(messages[0]);
  });

  it("drops a trailing assistant turn that already carries the persisted sentinel content (#77228)", () => {
    // Covers the case where session-file-repair persisted the sentinel to
    // disk; on the next turn the loaded transcript ends with a non-empty
    // assistant turn whose only content is the sentinel text. Provider
    // request must still end with user.
    const persistedSentinel = bedrockAssistant([{ type: "text", text: FALLBACK_TEXT }], "error");
    const messages = [userMessage("hello"), persistedSentinel];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(messages[0]);
  });

  it("drops several consecutive trailing sentinel/empty-error turns at the tail", () => {
    const messages = [
      userMessage("hi"),
      bedrockAssistant([{ type: "text", text: "real" }]),
      userMessage("again"),
      bedrockAssistant([], "error"),
      bedrockAssistant([{ type: "text", text: FALLBACK_TEXT }], "error"),
    ];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toHaveLength(3);
    expect((out.at(-1) as { role: string }).role).toBe("user");
  });

  it("does not drop a trailing assistant turn that has real content", () => {
    const realReply = bedrockAssistant([{ type: "text", text: "hello back" }], "stop", {
      input: 1,
      output: 1,
      totalTokens: 2,
    });
    const messages = [userMessage("hi"), realReply];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toBe(messages);
    expect(out).toHaveLength(2);
  });

  it("does not drop a trailing assistant turn with non-error empty content (toolUse / length)", () => {
    // Boundary lock: only error/zero-usage-empty-stop and the sentinel
    // shape are droppable. toolUse/length empty turns are real provider
    // states and must be preserved on the wire.
    const toolUse = bedrockAssistant([], "toolUse");
    const messages = [userMessage("hi"), toolUse];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toBe(messages);
    expect(out).toHaveLength(2);
  });

  it("preserves a trailing real model reply whose only content happens to be the sentinel text (clawsweeper review on #77287)", () => {
    // Defensive boundary: even if a model legitimately replies with the
    // exact sentinel string, the trim must require synthetic provenance
    // (stopReason: "error" or zero-usage stop) before dropping. Without
    // this guard the trim would silently delete a real reply on next
    // replay.
    const realReplyAsStop = bedrockAssistant([{ type: "text", text: FALLBACK_TEXT }], "stop", {
      input: 1,
      output: 1,
      totalTokens: 2,
    });
    const messages = [userMessage("hi"), realReplyAsStop];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toBe(messages);
    expect(out).toHaveLength(2);
    expect((out[1] as { content: unknown[] }).content).toEqual([
      { type: "text", text: FALLBACK_TEXT },
    ]);
  });

  it("preserves a trailing turn whose sentinel content is paired with stopReason: toolUse (real provider state, not synthetic)", () => {
    const toolUseSentinel = bedrockAssistant([{ type: "text", text: FALLBACK_TEXT }], "toolUse");
    const messages = [userMessage("hi"), toolUseSentinel];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toBe(messages);
    expect(out).toHaveLength(2);
  });

  it("still drops a trailing zero-usage stop turn whose content was already lifted to the sentinel block (post-rewrite shape)", () => {
    // Confirms the sentinel-content branch still recognizes the post-rewrite
    // shape produced by the in-memory rewrite earlier in the same loop:
    // stopReason: "stop" + zero usage + sentinel content. Only the synthetic
    // provenance (zero usage + stop) makes this droppable; a non-zero-usage
    // version is preserved by the regression test above.
    const persistedZeroUsageSentinel = bedrockAssistant(
      [{ type: "text", text: FALLBACK_TEXT }],
      "stop",
    );
    const messages = [userMessage("hi"), persistedZeroUsageSentinel];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(messages[0]);
  });
});
