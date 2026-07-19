// Coverage for normalizing assistant replay content before provider requests.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { OPENCLAW_TRANSCRIPT_ARTIFACT_API } from "../../shared/transcript-only-openclaw-assistant.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
} from "../internal-runtime-context.js";
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
  // Bedrock fixtures cover providers that can return empty or legacy-shaped
  // assistant content during streamed turns.
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
    api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
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
  it("keeps bare marked late-media turns alive while rejecting whitespace-only media fields", () => {
    const blankString = {
      role: "user",
      content: "",
      MediaPath: "/tmp/late.png",
      __openclaw: { lateMedia: true },
    } as unknown as AgentMessage;
    const blankArray = {
      role: "user",
      content: [{ type: "text", text: "  " }],
      MediaPaths: ["/tmp/late-array.png"],
      __openclaw: { lateMedia: true },
    } as unknown as AgentMessage;
    const whitespaceOnlyPath = {
      role: "user",
      content: "",
      MediaPath: "   ",
      __openclaw: { lateMedia: true },
    } as unknown as AgentMessage;
    const urlOnly = {
      role: "user",
      content: "",
      MediaUrl: "https://example.test/late.png",
      __openclaw: { lateMedia: true },
    } as unknown as AgentMessage;

    const out = normalizeAssistantReplayContent([
      blankString,
      blankArray,
      whitespaceOnlyPath,
      urlOnly,
    ]);

    expect(out).toEqual([blankString, { ...blankArray, content: "" }, urlOnly]);
  });

  it("converts mid-turn assistant content: [] to a non-empty sentinel text block when stopReason is error", () => {
    // Mid-turn failure sentinels preserve request turn ordering without
    // pretending the failed assistant generated useful content.
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

  it("preserves consecutive ambient user rows", () => {
    const messages = [
      userMessage("#10 Sam: first ambient"),
      userMessage("#11 Lee: second ambient"),
      userMessage("#12 Pat: @bot what now?"),
    ];
    expect(normalizeAssistantReplayContent(messages)).toBe(messages);
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

  it("converts mid-turn zero-usage null stop turns to a replay sentinel", () => {
    const falseSuccessStop = bedrockAssistant(null, "stop");
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

  it("drops reasoning-only length turns before provider replay", () => {
    const reasoningOnly = bedrockAssistant(
      [
        {
          type: "thinking",
          thinking: "partial hidden reasoning",
          thinkingSignature: "partial-signature",
        },
        { type: "text", text: "  " },
      ],
      "length",
      { output: 42, totalTokens: 42 },
    );
    const messages = [userMessage("before"), reasoningOnly, userMessage("continue")];

    const out = normalizeAssistantReplayContent(messages);

    expect(out).toEqual([messages[0], messages[2]]);
    expect(JSON.stringify(out)).not.toContain("partial-signature");
  });

  it("drops length turns that become reasoning-only after content normalization", () => {
    const messages = [
      userMessage("before"),
      bedrockAssistant(
        [
          {
            type: "thinking",
            thinking: "partial hidden reasoning",
            thinkingSignature: "partial-signature",
          },
          { type: "text", text: "NO_REPLY" },
        ],
        "length",
      ),
      {
        ...bedrockAssistant([], "length"),
        content: {
          type: "thinking",
          thinking: "partial object reasoning",
          thinkingSignature: "partial-object-signature",
        },
      },
      userMessage("continue"),
    ] as AgentMessage[];

    const out = normalizeAssistantReplayContent(messages);

    expect(out).toEqual([messages[0], messages[3]]);
  });

  it("preserves length turns with visible text or tool calls", () => {
    const visible = bedrockAssistant(
      [
        { type: "thinking", thinking: "partial reasoning", thinkingSignature: "sig_visible" },
        { type: "text", text: "partial visible answer" },
      ],
      "length",
    );
    const toolCall = bedrockAssistant(
      [
        { type: "thinking", thinking: "partial reasoning", thinkingSignature: "sig_tool" },
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      ],
      "length",
    );
    const messages = [userMessage("before"), visible, toolCall, userMessage("continue")];

    const out = normalizeAssistantReplayContent(messages);

    expect(out).toBe(messages);
  });

  it("wraps legacy string assistant content as a single text block (regression)", () => {
    const messages = [userMessage("hi"), bedrockAssistant("plain string content")];
    const out = normalizeAssistantReplayContent(messages);
    const wrapped = out[1] as AgentMessage & { content: { type: string; text: string }[] };
    expect(wrapped.content).toEqual([{ type: "text", text: "plain string content" }]);
  });

  it("wraps legacy object assistant content as a single block (regression)", () => {
    const block = { type: "text", text: "plain object content" };
    const messages = [userMessage("hi"), bedrockAssistant(block, "stop")];
    const out = normalizeAssistantReplayContent(messages);
    const wrapped = out[1] as AgentMessage & { content: unknown[] };
    expect(wrapped.content).toEqual([block]);
  });

  it("normalizes null assistant content to an empty block array (regression)", () => {
    const messages = [userMessage("hi"), bedrockAssistant(null, "toolUse")];
    const out = normalizeAssistantReplayContent(messages);
    const normalized = out[1] as AgentMessage & { content: unknown[] };
    expect(normalized.content).toEqual([]);
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

  it("drops standalone silent assistant replay text", () => {
    const messages = [userMessage("first"), bedrockAssistant("NO_REPLY"), userMessage("second")];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toEqual([messages[0], messages[2]]);
  });

  it("strips copied runtime context from assistant replay text", () => {
    const messages = [
      userMessage("first"),
      bedrockAssistant([
        {
          type: "text",
          text: [
            "Visible before",
            INTERNAL_RUNTIME_CONTEXT_BEGIN,
            "keep this internal",
            INTERNAL_RUNTIME_CONTEXT_END,
            OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
            OPENCLAW_RUNTIME_CONTEXT_NOTICE,
            "",
            "Visible after",
          ].join("\n"),
        },
      ]),
    ];
    const out = normalizeAssistantReplayContent(messages);
    const normalized = out[1] as AgentMessage & { content: unknown[] };
    expect(normalized.content).toEqual([{ type: "text", text: "Visible before\n\nVisible after" }]);
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
    // Gateway mirror entries are transcript artifacts, not model-authored
    // assistant turns, so they must not be sent back to providers.
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

  it.each(["channel-final", "channel-final-suppressed", "message-tool-source-reply"] as const)(
    "filters a stripped delivery mirror identified by %s",
    (kind) => {
      const strippedMirror = {
        ...bedrockAssistant([{ type: "text", text: "channel mirror" }], "stop"),
        provider: undefined,
        model: undefined,
        openclawDeliveryMirror: { kind },
      } as unknown as AgentMessage;
      const realReply = bedrockAssistant([{ type: "text", text: "real reply" }], "stop", {
        input: 1,
        output: 1,
        totalTokens: 2,
      });

      expect(
        normalizeAssistantReplayContent([userMessage("hello"), strippedMirror, realReply]),
      ).toEqual([expect.objectContaining({ role: "user" }), realReply]);
    },
  );

  it("preserves an assistant carrying an invalid delivery-mirror marker", () => {
    const assistant = {
      ...bedrockAssistant([{ type: "text", text: "real reply" }], "stop", {
        input: 1,
        output: 1,
        totalTokens: 2,
      }),
      openclawDeliveryMirror: { kind: "unknown" },
    } as unknown as AgentMessage;
    const messages = [userMessage("hello"), assistant];

    expect(normalizeAssistantReplayContent(messages)).toBe(messages);
  });

  it("filters an adjacent marker-free zero-usage delivery mirror", () => {
    const content = [{ type: "text", text: "real reply" }];
    const realReply = bedrockAssistant(content, "stop", {
      input: 1,
      output: 1,
      totalTokens: 2,
    });
    const bareMirror = bedrockAssistant([{ text: "real reply", type: "text" }], "stop");

    expect(normalizeAssistantReplayContent([userMessage("hello"), realReply, bareMirror])).toEqual([
      expect.objectContaining({ role: "user" }),
      realReply,
    ]);
  });

  it("preserves adjacent identical assistant turns with nonzero usage", () => {
    const content = [{ type: "text", text: "intentional repeat" }];
    const first = bedrockAssistant(content, "stop", { output: 1, totalTokens: 1 });
    const second = bedrockAssistant(content, "stop", { output: 1, totalTokens: 1 });
    const messages = [userMessage("repeat"), first, second];

    expect(normalizeAssistantReplayContent(messages)).toBe(messages);
  });

  it("preserves adjacent zero-usage assistant turns with tool calls", () => {
    const content = [
      { type: "text", text: "checking" },
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "file.txt" } },
    ];
    const first = bedrockAssistant(content, "stop");
    const second = bedrockAssistant(content, "stop");
    const messages = [userMessage("check"), first, second];

    expect(normalizeAssistantReplayContent(messages)).toBe(messages);
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
    expect(out).toStrictEqual([messages[0]]);
  });

  it("drops a trailing zero-usage empty stop assistant turn (#77228)", () => {
    const falseSuccessStop = bedrockAssistant([], "stop");
    const messages = [userMessage("hello"), falseSuccessStop];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toStrictEqual([messages[0]]);
  });

  it("drops a trailing assistant turn that already carries the persisted sentinel content (#77228)", () => {
    // Covers the case where session-file-repair persisted the sentinel to
    // disk; on the next turn the loaded transcript ends with a non-empty
    // assistant turn whose only content is the sentinel text. Provider
    // request must still end with user.
    const persistedSentinel = bedrockAssistant([{ type: "text", text: FALLBACK_TEXT }], "error");
    const messages = [userMessage("hello"), persistedSentinel];
    const out = normalizeAssistantReplayContent(messages);
    expect(out).toStrictEqual([messages[0]]);
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
    expect(out).toStrictEqual([messages[0]]);
  });
});
