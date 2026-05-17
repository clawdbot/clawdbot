import { afterEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { parseAudioTag } from "./audio-tags.js";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";
import { matchesMentionWithExplicit } from "./mentions.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { createReplyReferencePlanner, isSingleUseReplyToMode } from "./reply-reference.js";
import {
  extractShortModelName,
  hasTemplateVariables,
  resolveResponsePrefixTemplate,
} from "./response-prefix-template.js";
import {
  createStreamingDirectiveAccumulator,
  splitTrailingDirective,
} from "./streaming-directives.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler, resolveTypingMode } from "./typing-mode.js";
import { createTypingController } from "./typing.js";

type NormalizedReplyPayload = NonNullable<ReturnType<typeof normalizeReplyPayload>>;

function expectNormalizedReply(
  result: ReturnType<typeof normalizeReplyPayload>,
): NormalizedReplyPayload {
  if (result === null) {
    throw new Error("Expected normalized reply payload");
  }
  return result;
}

describe("matchesMentionWithExplicit", () => {
  const mentionRegexes = [/\bopenclaw\b/i];

  it("combines explicit-mention state with regex fallback rules", () => {
    const cases = [
      {
        name: "regex match with explicit resolver available",
        text: "@openclaw hello",
        mentionRegexes,
        explicit: {
          hasAnyMention: true,
          isExplicitlyMentioned: false,
          canResolveExplicit: true,
        },
        expected: true,
      },
      {
        name: "no explicit and no regex match",
        text: "<@999999> hello",
        mentionRegexes,
        explicit: {
          hasAnyMention: true,
          isExplicitlyMentioned: false,
          canResolveExplicit: true,
        },
        expected: false,
      },
      {
        name: "explicit mention even without regex",
        text: "<@123456>",
        mentionRegexes: [],
        explicit: {
          hasAnyMention: true,
          isExplicitlyMentioned: true,
          canResolveExplicit: true,
        },
        expected: true,
      },
      {
        name: "falls back to regex when explicit cannot resolve",
        text: "openclaw please",
        mentionRegexes,
        explicit: {
          hasAnyMention: true,
          isExplicitlyMentioned: false,
          canResolveExplicit: false,
        },
        expected: true,
      },
    ] as const;
    for (const testCase of cases) {
      const result = matchesMentionWithExplicit({
        text: testCase.text,
        mentionRegexes: [...testCase.mentionRegexes],
        explicit: testCase.explicit,
      });
      expect(result, testCase.name).toBe(testCase.expected);
    }
  });

  it("lets catch-all regexes activate empty text without matching specific patterns", () => {
    expect(
      matchesMentionWithExplicit({
        text: "",
        mentionRegexes: [/.*/i],
      }),
    ).toBe(true);
    expect(
      matchesMentionWithExplicit({
        text: "",
        mentionRegexes,
      }),
    ).toBe(false);
  });
});

// Keep channelData-only payloads so channel-specific replies survive normalization.
describe("normalizeReplyPayload", () => {
  it("keeps channelData-only replies", () => {
    const payload = {
      channelData: {
        line: {
          flexMessage: { type: "bubble" },
        },
      },
    };

    const normalized = normalizeReplyPayload(payload);

    const reply = expectNormalizedReply(normalized);
    expect(reply.text).toBeUndefined();
    expect(reply.channelData).toEqual(payload.channelData);
  });

  it("records skip reasons for silent/empty payloads", () => {
    const cases = [
      { name: "silent", payload: { text: SILENT_REPLY_TOKEN }, reason: "silent" },
      { name: "empty", payload: { text: "   " }, reason: "empty" },
    ] as const;
    for (const testCase of cases) {
      const reasons: string[] = [];
      const normalized = normalizeReplyPayload(testCase.payload, {
        onSkip: (reason) => reasons.push(reason),
      });
      expect(normalized, testCase.name).toBeNull();
      expect(reasons, testCase.name).toEqual([testCase.reason]);
    }
  });

  it("strips NO_REPLY from mixed emoji message (#30916)", () => {
    const result = normalizeReplyPayload({ text: "😄 NO_REPLY" });
    const reply = expectNormalizedReply(result);
    expect(reply.text).toContain("😄");
    expect(reply.text).not.toContain("NO_REPLY");
  });

  it("strips NO_REPLY appended after substantive text (#30916)", () => {
    const result = normalizeReplyPayload({
      text: "File's there. Not urgent.\n\nNO_REPLY",
    });
    const reply = expectNormalizedReply(result);
    expect(reply.text).toContain("File's there");
    expect(reply.text).not.toContain("NO_REPLY");
  });

  it("strips glued leading NO_REPLY text without leaking the token", () => {
    const result = normalizeReplyPayload({
      text: "NO_REPLYThe user is saying hello",
    });
    expect(expectNormalizedReply(result).text).toBe("The user is saying hello");
  });

  it("strips glued leading NO_REPLY text case-insensitively", () => {
    const result = normalizeReplyPayload({
      text: "no_replyThe user is saying hello",
    });
    expect(expectNormalizedReply(result).text).toBe("The user is saying hello");
  });

  it("keeps NO_REPLY when used as leading substantive text", () => {
    const result = normalizeReplyPayload({ text: "NO_REPLY -- nope" });
    expect(expectNormalizedReply(result).text).toBe("NO_REPLY -- nope");
  });

  it("keeps punctuation-start content after a leading NO_REPLY token", () => {
    const colonResult = normalizeReplyPayload({ text: "NO_REPLY: explanation" });
    expect(expectNormalizedReply(colonResult).text).toBe("NO_REPLY: explanation");

    const dashResult = normalizeReplyPayload({ text: "NO_REPLY—note" });
    expect(expectNormalizedReply(dashResult).text).toBe("NO_REPLY—note");
  });

  it("suppresses message when stripping NO_REPLY leaves nothing", () => {
    const reasons: string[] = [];
    const result = normalizeReplyPayload(
      { text: "  NO_REPLY  " },
      { onSkip: (reason) => reasons.push(reason) },
    );
    expect(result).toBeNull();
    expect(reasons).toEqual(["silent"]);
  });

  it("suppresses JSON NO_REPLY action payloads", () => {
    const reasons: string[] = [];
    const result = normalizeReplyPayload(
      { text: '{"action":"NO_REPLY"}' },
      { onSkip: (reason) => reasons.push(reason) },
    );
    expect(result).toBeNull();
    expect(reasons).toEqual(["silent"]);
  });

  it("does not suppress JSON NO_REPLY objects with extra fields", () => {
    const result = normalizeReplyPayload({
      text: '{"action":"NO_REPLY","note":"example"}',
    });
    expect(expectNormalizedReply(result).text).toBe('{"action":"NO_REPLY","note":"example"}');
  });

  it("strips NO_REPLY but keeps media payload", () => {
    const result = normalizeReplyPayload({
      text: "NO_REPLY",
      mediaUrl: "https://example.com/img.png",
    });
    const reply = expectNormalizedReply(result);
    expect(reply.text).toBe("");
    expect(reply.mediaUrl).toBe("https://example.com/img.png");
  });

  it("strips JSON NO_REPLY action text but keeps media payload", () => {
    const result = normalizeReplyPayload({
      text: '{"action":"NO_REPLY"}',
      mediaUrl: "https://example.com/img.png",
    });
    const reply = expectNormalizedReply(result);
    expect(reply.text).toBe("");
    expect(reply.mediaUrl).toBe("https://example.com/img.png");
  });

  it("strips legacy uppercase TOOL_CALL blocks from normalized replies", () => {
    const result = normalizeReplyPayload({
      text: [
        "Before",
        '[TOOL_CALL]{tool => "web_search", args => {"query":"NET stock price"}}[/TOOL_CALL]',
        "After",
      ].join("\n"),
    });

    expect(expectNormalizedReply(result).text).toBe("Before\n\nAfter");
  });

  it("strips legacy uppercase TOOL_RESULT blocks from normalized replies", () => {
    const result = normalizeReplyPayload({
      text: ["Before", '[TOOL_RESULT]{"output":"secret result"}[/TOOL_RESULT]', "After"].join("\n"),
    });

    expect(expectNormalizedReply(result).text).toBe("Before\n\nAfter");
  });

  it("does not compile Slack directives unless interactive replies are enabled", () => {
    const result = normalizeReplyPayload({
      text: "hello [[slack_buttons: Retry:retry, Ignore:ignore]]",
    });

    const reply = expectNormalizedReply(result);
    expect(reply.text).toBe("hello [[slack_buttons: Retry:retry, Ignore:ignore]]");
    expect(reply.interactive).toBeUndefined();
  });

  it("applies responsePrefix before channel-owned transforms run", () => {
    const result = normalizeReplyPayload(
      {
        text: "hello [[slack_buttons: Retry:retry, Ignore:ignore]]",
      },
      { responsePrefix: "[bot]" },
    );

    const reply = expectNormalizedReply(result);
    expect(reply.text).toBe("[bot] hello [[slack_buttons: Retry:retry, Ignore:ignore]]");
    expect(reply.interactive).toBeUndefined();
  });

  it("leaves trailing Options lines for channel-owned transforms", () => {
    const result = normalizeReplyPayload({
      text: "Current verbose level: off.\nOptions: on, full, off.",
    });

    const reply = expectNormalizedReply(result);
    expect(reply.text).toBe("Current verbose level: off.\nOptions: on, full, off.");
    expect(reply.interactive).toBeUndefined();
  });

  it("leaves larger Options lists for channel-owned transforms", () => {
    const result = normalizeReplyPayload({
      text: "Choose a reasoning level.\nOptions: off, minimal, low, medium, high, adaptive.",
    });

    const reply = expectNormalizedReply(result);
    expect(reply.text).toBe(
      "Choose a reasoning level.\nOptions: off, minimal, low, medium, high, adaptive.",
    );
    expect(reply.interactive).toBeUndefined();
  });

  it("leaves complex Options lines as plain text", () => {
    const result = normalizeReplyPayload({
      text: "ACP runtime choices.\nOptions: host=auto|sandbox|gateway|node, security=deny|allowlist|full.",
    });

    const reply = expectNormalizedReply(result);
    expect(reply.text).toBe(
      "ACP runtime choices.\nOptions: host=auto|sandbox|gateway|node, security=deny|allowlist|full.",
    );
    expect(reply.interactive).toBeUndefined();
  });
});

describe("typing controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createTestTypingController() {
    const onReplyStart = vi.fn();
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });
    return { typing, onReplyStart };
  }

  function markTypingState(
    typing: ReturnType<typeof createTypingController>,
    state: "run" | "idle",
  ) {
    if (state === "run") {
      typing.markRunComplete();
      return;
    }
    typing.markDispatchIdle();
  }

  it("stops only after both run completion and dispatcher idle are set (any order)", async () => {
    vi.useFakeTimers();
    const cases = [
      { name: "run-complete first", first: "run", second: "idle" },
      { name: "dispatch-idle first", first: "idle", second: "run" },
    ] as const;

    for (const testCase of cases) {
      const { typing, onReplyStart } = createTestTypingController();

      await typing.startTypingLoop();
      expect(onReplyStart, testCase.name).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(onReplyStart, testCase.name).toHaveBeenCalledTimes(3);

      markTypingState(typing, testCase.first);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onReplyStart, testCase.name).toHaveBeenCalledTimes(testCase.first === "run" ? 3 : 5);

      markTypingState(typing, testCase.second);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onReplyStart, testCase.name).toHaveBeenCalledTimes(testCase.first === "run" ? 3 : 5);
    }
  });

  it("does not start typing after run completion", async () => {
    vi.useFakeTimers();
    const { typing, onReplyStart } = createTestTypingController();

    typing.markRunComplete();
    await typing.startTypingOnText("late text");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onReplyStart).not.toHaveBeenCalled();
  });

  it("does not restart typing after it has stopped", async () => {
    vi.useFakeTimers();
    const { typing, onReplyStart } = createTestTypingController();

    await typing.startTypingLoop();
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    typing.markRunComplete();
    typing.markDispatchIdle();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    // Late callbacks should be ignored and must not restart the interval.
    await typing.startTypingOnText("late tool result");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });
});

describe("resolveTypingMode", () => {
  it("resolves defaults, configured overrides, and heartbeat suppression", () => {
    const cases = [
      {
        name: "default direct chat",
        input: {
          configured: undefined,
          isGroupChat: false,
          wasMentioned: false,
          isHeartbeat: false,
        },
        expected: "instant",
      },
      {
        name: "default group chat without mention",
        input: {
          configured: undefined,
          isGroupChat: true,
          wasMentioned: false,
          isHeartbeat: false,
        },
        expected: "message",
      },
      {
        name: "message-tool-only group chat starts typing immediately",
        input: {
          configured: undefined,
          isGroupChat: true,
          wasMentioned: false,
          isHeartbeat: false,
          sourceReplyDeliveryMode: "message_tool_only" as const,
        },
        expected: "instant",
      },
      {
        name: "configured group typing mode wins over message-tool-only default",
        input: {
          configured: "message" as const,
          isGroupChat: true,
          wasMentioned: false,
          isHeartbeat: false,
          sourceReplyDeliveryMode: "message_tool_only" as const,
        },
        expected: "message",
      },
      {
        name: "default mentioned group chat",
        input: {
          configured: undefined,
          isGroupChat: true,
          wasMentioned: true,
          isHeartbeat: false,
        },
        expected: "instant",
      },
      {
        name: "configured thinking override",
        input: {
          configured: "thinking" as const,
          isGroupChat: false,
          wasMentioned: false,
          isHeartbeat: false,
        },
        expected: "thinking",
      },
      {
        name: "configured message override",
        input: {
          configured: "message" as const,
          isGroupChat: true,
          wasMentioned: true,
          isHeartbeat: false,
        },
        expected: "message",
      },
      {
        name: "heartbeat forces never",
        input: {
          configured: "instant" as const,
          isGroupChat: false,
          wasMentioned: false,
          isHeartbeat: true,
        },
        expected: "never",
      },
      {
        name: "suppressTyping forces never",
        input: {
          configured: "instant" as const,
          isGroupChat: false,
          wasMentioned: false,
          isHeartbeat: false,
          suppressTyping: true,
        },
        expected: "never",
      },
      {
        name: "typingPolicy system_event forces never",
        input: {
          configured: "instant" as const,
          isGroupChat: false,
          wasMentioned: false,
          isHeartbeat: false,
          typingPolicy: "system_event" as const,
        },
        expected: "never",
      },
    ] as const;

    for (const testCase of cases) {
      expect(resolveTypingMode(testCase.input), testCase.name).toBe(testCase.expected);
    }
  });
});

describe("parseAudioTag", () => {
  it("extracts audio tag state and cleaned text", () => {
    const cases = [
      {
        name: "tag in sentence",
        input: "Hello [[audio_as_voice]] world",
        expected: { audioAsVoice: true, hadTag: true, text: "Hello world" },
      },
      {
        name: "missing text",
        input: undefined,
        expected: { audioAsVoice: false, hadTag: false, text: "" },
      },
      {
        name: "tag-only content",
        input: "[[audio_as_voice]]",
        expected: { audioAsVoice: true, hadTag: true, text: "" },
      },
    ] as const;
    for (const testCase of cases) {
      const result = parseAudioTag(testCase.input);
      expect(result.audioAsVoice, testCase.name).toBe(testCase.expected.audioAsVoice);
      expect(result.hadTag, testCase.name).toBe(testCase.expected.hadTag);
      expect(result.text, testCase.name).toBe(testCase.expected.text);
    }
  });
});

describe("resolveResponsePrefixTemplate", () => {
  function expectResolvedTemplateCases(
    cases: ReadonlyArray<{
      name: string;
      template: string | undefined;
      values: Parameters<typeof resolveResponsePrefixTemplate>[1];
      expected: string | undefined;
    }>,
  ) {
    for (const testCase of cases) {
      expect(resolveResponsePrefixTemplate(testCase.template, testCase.values), testCase.name).toBe(
        testCase.expected,
      );
    }
  }

  it("resolves known variables, aliases, and case-insensitive tokens", () => {
    const cases = [
      {
        name: "model",
        template: "[{model}]",
        values: { model: "gpt-5.4" },
        expected: "[gpt-5.4]",
      },
      {
        name: "modelFull",
        template: "[{modelFull}]",
        values: { modelFull: "openai-codex/gpt-5.4" },
        expected: "[openai-codex/gpt-5.4]",
      },
      {
        name: "provider",
        template: "[{provider}]",
        values: { provider: "anthropic" },
        expected: "[anthropic]",
      },
      {
        name: "thinkingLevel",
        template: "think:{thinkingLevel}",
        values: { thinkingLevel: "high" },
        expected: "think:high",
      },
      {
        name: "think alias",
        template: "think:{think}",
        values: { thinkingLevel: "low" },
        expected: "think:low",
      },
      {
        name: "identity.name",
        template: "[{identity.name}]",
        values: { identityName: "OpenClaw" },
        expected: "[OpenClaw]",
      },
      {
        name: "identityName alias",
        template: "[{identityName}]",
        values: { identityName: "OpenClaw" },
        expected: "[OpenClaw]",
      },
      {
        name: "case-insensitive variables",
        template: "[{MODEL} | {ThinkingLevel}]",
        values: { model: "gpt-5.4", thinkingLevel: "low" },
        expected: "[gpt-5.4 | low]",
      },
      {
        name: "all variables",
        template: "[{identity.name}] {provider}/{model} (think:{thinkingLevel})",
        values: {
          identityName: "OpenClaw",
          provider: "anthropic",
          model: "claude-opus-4-6",
          thinkingLevel: "high",
        },
        expected: "[OpenClaw] anthropic/claude-opus-4-6 (think:high)",
      },
    ] as const;
    expectResolvedTemplateCases(cases);
  });

  it("preserves unresolved/unknown placeholders and handles static inputs", () => {
    const cases = [
      { name: "undefined template", template: undefined, values: {}, expected: undefined },
      { name: "no variables", template: "[Claude]", values: {}, expected: "[Claude]" },
      {
        name: "unresolved known variable",
        template: "[{model}]",
        values: {},
        expected: "[{model}]",
      },
      {
        name: "unrecognized variable",
        template: "[{unknownVar}]",
        values: { model: "gpt-5.4" },
        expected: "[{unknownVar}]",
      },
      {
        name: "mixed resolved/unresolved",
        template: "[{model} | {provider}]",
        values: { model: "gpt-5.4" },
        expected: "[gpt-5.4 | {provider}]",
      },
    ] as const;
    expectResolvedTemplateCases(cases);
  });
});

describe("createTypingSignaler", () => {
  it("gates run-start typing by mode", async () => {
    const cases = [
      { name: "instant", mode: "instant" as const, expectedStartCalls: 1 },
      { name: "message", mode: "message" as const, expectedStartCalls: 0 },
      { name: "thinking", mode: "thinking" as const, expectedStartCalls: 0 },
    ] as const;
    for (const testCase of cases) {
      const typing = createMockTypingController();
      const signaler = createTypingSignaler({
        typing,
        mode: testCase.mode,
        isHeartbeat: false,
      });

      await signaler.signalRunStart();
      expect(typing.startTypingLoop, testCase.name).toHaveBeenCalledTimes(
        testCase.expectedStartCalls,
      );
    }
  });

  it("signals on message-mode boundaries and text deltas", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalMessageStart();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    await signaler.signalTextDelta("hello");
    expect(typing.startTypingOnText).toHaveBeenCalledWith("hello");
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("starts typing and refreshes ttl on text for thinking mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "thinking",
      isHeartbeat: false,
    });

    await signaler.signalReasoningDelta();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    await signaler.signalTextDelta("hi");
    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expect(typing.refreshTypingTtl).toHaveBeenCalledTimes(1);
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("does not start typing for media-only deltas", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalTextDelta(undefined);

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("handles tool-start typing before and after active text mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalToolStart();

    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expect(typing.refreshTypingTtl).toHaveBeenCalledTimes(1);
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    (typing.isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (typing.startTypingLoop as ReturnType<typeof vi.fn>).mockClear();
    (typing.refreshTypingTtl as ReturnType<typeof vi.fn>).mockClear();
    await signaler.signalToolStart();

    expect(typing.refreshTypingTtl).toHaveBeenCalledTimes(1);
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("suppresses typing when disabled", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "instant",
      isHeartbeat: true,
    });

    await signaler.signalRunStart();
    await signaler.signalTextDelta("hi");
    await signaler.signalReasoningDelta();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });
});

describe("block reply coalescer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createBlockCoalescerHarness(config: {
    minChars: number;
    maxChars: number;
    idleMs: number;
    joiner: string;
    flushOnEnqueue?: boolean;
  }) {
    const flushes: string[] = [];
    const coalescer = createBlockReplyCoalescer({
      config,
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push(payload.text ?? "");
      },
    });
    return { flushes, coalescer };
  }

  it("coalesces chunks within the idle window", async () => {
    vi.useFakeTimers();
    const { flushes, coalescer } = createBlockCoalescerHarness({
      minChars: 1,
      maxChars: 200,
      idleMs: 100,
      joiner: " ",
    });

    coalescer.enqueue({ text: "Hello" });
    coalescer.enqueue({ text: "world" });

    await vi.advanceTimersByTimeAsync(100);
    expect(flushes).toEqual(["Hello world"]);
    coalescer.stop();
  });

  it("waits until minChars before idle flush", async () => {
    vi.useFakeTimers();
    const { flushes, coalescer } = createBlockCoalescerHarness({
      minChars: 10,
      maxChars: 200,
      idleMs: 50,
      joiner: " ",
    });

    coalescer.enqueue({ text: "short" });
    await vi.advanceTimersByTimeAsync(50);
    expect(flushes).toStrictEqual([]);

    coalescer.enqueue({ text: "message" });
    await vi.advanceTimersByTimeAsync(50);
    expect(flushes).toEqual(["short message"]);
    coalescer.stop();
  });

  it("still accumulates when flushOnEnqueue is not set (default)", async () => {
    vi.useFakeTimers();
    const { flushes, coalescer } = createBlockCoalescerHarness({
      minChars: 1,
      maxChars: 2000,
      idleMs: 100,
      joiner: "\n\n",
    });

    coalescer.enqueue({ text: "First paragraph" });
    coalescer.enqueue({ text: "Second paragraph" });

    await vi.advanceTimersByTimeAsync(100);
    expect(flushes).toEqual(["First paragraph\n\nSecond paragraph"]);
    coalescer.stop();
  });

  it("keeps buffering newline-style chunks until minChars is reached", async () => {
    vi.useFakeTimers();
    const { flushes, coalescer } = createBlockCoalescerHarness({
      minChars: 25,
      maxChars: 2000,
      idleMs: 50,
      joiner: "\n\n",
    });

    coalescer.enqueue({ text: "First paragraph" });
    coalescer.enqueue({ text: "Second paragraph" });

    await vi.advanceTimersByTimeAsync(50);
    expect(flushes).toEqual(["First paragraph\n\nSecond paragraph"]);
    coalescer.stop();
  });

  it("force flushes buffered newline-style chunks even below minChars", async () => {
    const { flushes, coalescer } = createBlockCoalescerHarness({
      minChars: 100,
      maxChars: 2000,
      idleMs: 50,
      joiner: "\n\n",
    });

    coalescer.enqueue({ text: "First paragraph" });
    coalescer.enqueue({ text: "Second paragraph" });
    await coalescer.flush({ force: true });

    expect(flushes).toEqual(["First paragraph\n\nSecond paragraph"]);
    coalescer.stop();
  });

  it("does not coalesce reasoning blocks into visible reply text", async () => {
    const flushes: Array<{ text?: string; isReasoning?: boolean }> = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 200, idleMs: 0, joiner: "\n\n" },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push({
          text: payload.text,
          isReasoning: payload.isReasoning,
        });
      },
    });

    coalescer.enqueue({ text: "hidden", isReasoning: true });
    coalescer.enqueue({ text: "Visible answer" });
    await coalescer.flush({ force: true });

    expect(flushes).toEqual([
      { text: "hidden", isReasoning: true },
      { text: "Visible answer", isReasoning: undefined },
    ]);
    coalescer.stop();
  });

  it("preserves compaction notice markers across flushes", async () => {
    const flushes: Array<{
      text?: string;
      isCompactionNotice?: boolean;
      isFallbackNotice?: boolean;
    }> = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 200, idleMs: 0, joiner: "\n\n" },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push({
          text: payload.text,
          isCompactionNotice: payload.isCompactionNotice,
          isFallbackNotice: payload.isFallbackNotice,
        });
      },
    });

    coalescer.enqueue({ text: "Compacting context...", isCompactionNotice: true });
    coalescer.enqueue({ text: "Model Fallback: openai/gpt-5.5", isFallbackNotice: true });
    await coalescer.flush({ force: true });

    expect(flushes).toEqual([
      {
        text: "Compacting context...",
        isCompactionNotice: true,
        isFallbackNotice: undefined,
      },
      {
        text: "Model Fallback: openai/gpt-5.5",
        isCompactionNotice: undefined,
        isFallbackNotice: true,
      },
    ]);
    coalescer.stop();
  });

  it("flushes immediately per enqueue when flushOnEnqueue is set", async () => {
    const cases = [
      {
        config: { minChars: 10, maxChars: 200, idleMs: 50, joiner: "\n\n", flushOnEnqueue: true },
        inputs: ["Hi"],
        expected: ["Hi"],
      },
      {
        config: { minChars: 1, maxChars: 30, idleMs: 100, joiner: "\n\n", flushOnEnqueue: true },
        inputs: ["12345678901234567890", "abcdefghijklmnopqrst"],
        expected: ["12345678901234567890", "abcdefghijklmnopqrst"],
      },
    ] as const;

    for (const testCase of cases) {
      const { flushes, coalescer } = createBlockCoalescerHarness(testCase.config);
      for (const input of testCase.inputs) {
        coalescer.enqueue({ text: input });
      }
      await Promise.resolve();
      expect(flushes).toEqual(testCase.expected);
      coalescer.stop();
    }
  });

  it("flushes buffered text before media payloads", () => {
    const flushes: Array<{ text?: string; mediaUrls?: string[] }> = [];
    const coalescer = createBlockReplyCoalescer({
      config: { minChars: 1, maxChars: 200, idleMs: 0, joiner: " " },
      shouldAbort: () => false,
      onFlush: (payload) => {
        flushes.push({
          text: payload.text,
          mediaUrls: payload.mediaUrls,
        });
      },
    });

    coalescer.enqueue({ text: "Hello" });
    coalescer.enqueue({ text: "world" });
    coalescer.enqueue({ mediaUrls: ["https://example.com/a.png"] });
    void coalescer.flush({ force: true });

    expect(flushes[0].text).toBe("Hello world");
    expect(flushes[1].mediaUrls).toEqual(["https://example.com/a.png"]);
    coalescer.stop();
  });
});

describe("createReplyReferencePlanner", () => {
  it("plans references correctly for off/first/all modes", () => {
    const offPlanner = createReplyReferencePlanner({
      replyToMode: "off",
      startId: "parent",
    });
    expect(offPlanner.use()).toBeUndefined();

    const firstPlanner = createReplyReferencePlanner({
      replyToMode: "first",
      startId: "parent",
    });
    expect(firstPlanner.peek()).toBe("parent");
    expect(firstPlanner.hasReplied()).toBe(false);
    expect(firstPlanner.use()).toBe("parent");
    expect(firstPlanner.hasReplied()).toBe(true);
    firstPlanner.markSent();
    expect(firstPlanner.peek()).toBeUndefined();
    expect(firstPlanner.use()).toBeUndefined();

    const allPlanner = createReplyReferencePlanner({
      replyToMode: "all",
      startId: "parent",
    });
    expect(allPlanner.peek()).toBe("parent");
    expect(allPlanner.hasReplied()).toBe(false);
    expect(allPlanner.use()).toBe("parent");
    expect(allPlanner.use()).toBe("parent");

    const existingIdPlanner = createReplyReferencePlanner({
      replyToMode: "first",
      existingId: "thread-1",
      startId: "parent",
    });
    expect(existingIdPlanner.use()).toBe("thread-1");
    expect(existingIdPlanner.use()).toBeUndefined();

    const batchedPlanner = createReplyReferencePlanner({
      replyToMode: "batched",
      startId: "parent",
    });
    expect(batchedPlanner.peek()).toBe("parent");
    expect(batchedPlanner.use()).toBe("parent");
    expect(batchedPlanner.peek()).toBeUndefined();
    expect(batchedPlanner.use()).toBeUndefined();
  });

  it("lets transient previews inspect first references without consuming them", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "first",
      startId: "parent",
    });

    expect(planner.peek()).toBe("parent");
    expect(planner.peek()).toBe("parent");
    expect(planner.hasReplied()).toBe(false);

    planner.markSent();

    expect(planner.peek()).toBeUndefined();
    expect(planner.use()).toBeUndefined();
  });

  it("honors allowReference=false", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      startId: "parent",
      allowReference: false,
    });
    expect(planner.use()).toBeUndefined();
    expect(planner.hasReplied()).toBe(false);
    planner.markSent();
    expect(planner.hasReplied()).toBe(true);
  });
});

describe("isSingleUseReplyToMode", () => {
  it("treats first and batched as single-use reply modes", () => {
    expect(isSingleUseReplyToMode("off")).toBe(false);
    expect(isSingleUseReplyToMode("all")).toBe(false);
    expect(isSingleUseReplyToMode("first")).toBe(true);
    expect(isSingleUseReplyToMode("batched")).toBe(true);
  });
});

describe("createStreamingDirectiveAccumulator", () => {
  it("stashes reply_to_current until a renderable chunk arrives", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to_current]]")).toBeNull();

    const result = accumulator.consume("Hello");
    expect(result?.text).toBe("Hello");
    expect(result?.replyToCurrent).toBe(true);
    expect(result?.replyToTag).toBe(true);
  });

  it("handles reply tags split across chunks", () => {
    const accumulator = createStreamingDirectiveAccumulator();
    expect(accumulator.consume("[[reply_to_")).toBeNull();

    const result = accumulator.consume("current]] Yo");
    expect(result?.text).toBe("Yo");
    expect(result?.replyToCurrent).toBe(true);
  });

  it("handles reply tags split before the second bracket", () => {
    const accumulator = createStreamingDirectiveAccumulator();
    expect(accumulator.consume("[")).toBeNull();

    const result = accumulator.consume("[reply_to_current]] Yo");
    expect(result?.text).toBe("Yo");
    expect(result?.replyToCurrent).toBe(true);
  });

  it("propagates explicit reply ids across current and subsequent chunks", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to: abc-123]]")).toBeNull();

    const first = accumulator.consume("Hi");
    expect(first?.text).toBe("Hi");
    expect(first?.replyToId).toBe("abc-123");
    expect(first?.replyToTag).toBe(true);

    const second = accumulator.consume("test 2");
    expect(second?.replyToId).toBe("abc-123");
    expect(second?.replyToTag).toBe(true);
  });

  it("clears sticky reply context on reset", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to_current]]")).toBeNull();
    expect(accumulator.consume("first")?.replyToCurrent).toBe(true);

    accumulator.reset();

    const afterReset = accumulator.consume("second");
    expect(afterReset?.replyToCurrent).toBe(false);
    expect(afterReset?.replyToTag).toBe(false);
    expect(afterReset?.replyToId).toBeUndefined();
  });

  it("strips a glued leading NO_REPLY token from streamed text", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    const result = accumulator.consume("NO_REPLYThe user is saying hello");

    expect(result?.text).toBe("The user is saying hello");
  });

  it("keeps punctuation-start text after a leading NO_REPLY token", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    const result = accumulator.consume("NO_REPLY: explanation");

    expect(result?.text).toBe("NO_REPLY: explanation");
  });

  it("reassembles MEDIA: directives split between the token and the colon", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    const first = accumulator.consume("这次直接发图。\n\nMEDIA");
    expect(first?.text).toBe("这次直接发图。");
    expect(first?.mediaUrls).toBeUndefined();

    const second = accumulator.consume(":/tmp/spy-family.png");
    expect(second).toBeNull();

    const finalResult = accumulator.consume("", { final: true });
    expect(finalResult?.mediaUrls).toEqual(["/tmp/spy-family.png"]);
    expect((finalResult?.text ?? "").includes("MEDIA")).toBe(false);
  });

  it("reassembles MEDIA: directives split inside the URL path", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    const first = accumulator.consume("Preview below.\n\nMEDIA:/var/folders/tool-image");
    expect(first?.text).toBe("Preview below.");
    expect(first?.mediaUrls).toBeUndefined();

    const second = accumulator.consume("-generation/cover.png");
    expect(second).toBeNull();

    const finalResult = accumulator.consume("", { final: true });
    expect(finalResult?.mediaUrls).toEqual(["/var/folders/tool-image-generation/cover.png"]);
  });

  it("buffers partial MEDIA prefixes (M/ME/MED/MEDI) across chunk boundaries", () => {
    for (const prefix of ["M", "ME", "MED", "MEDI"]) {
      const accumulator = createStreamingDirectiveAccumulator();
      const head = `Here is the file.\n\n${prefix}`;
      const headResult = accumulator.consume(head);
      expect(headResult?.text, `prefix=${prefix} head emits text`).toBe("Here is the file.");

      const rest = `MEDIA:/tmp/file.png`.slice(prefix.length);
      const restResult = accumulator.consume(rest);
      expect(restResult, `prefix=${prefix} mid returns null`).toBeNull();

      const finalResult = accumulator.consume("", { final: true });
      expect(finalResult?.mediaUrls, `prefix=${prefix} final mediaUrls`).toEqual(["/tmp/file.png"]);
    }
  });

  it("does not buffer a trailing letter that appears mid-line", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    // "I am" ends in "m". The prefix guard only anchors to line-start (`^`
    // or immediately after `\n`), so ordinary prose whose last character
    // happens to be an `M|ME|MED|MEDI|MEDIA` letter stays in the emitted
    // text.
    const result = accumulator.consume("I am");
    expect(result?.text).toBe("I am");
    expect(result?.mediaUrls).toBeUndefined();
  });

  it("does not buffer prose that merely contains the token MEDIA:", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    // Matches what upstream `splitMediaFromOutput` considers a directive:
    // only lines whose trimmed start is `MEDIA:`. A line that merely
    // contains "MEDIA:" mid-sentence is ordinary prose and must flush
    // immediately — otherwise on a stream-item boundary (which may call
    // `reset()` without a preceding `consume("", { final: true })`) the
    // buffered prose would be silently dropped.
    const result = accumulator.consume("See the MEDIA: section for details");
    expect(result?.text).toBe("See the MEDIA: section for details");
    expect(result?.mediaUrls).toBeUndefined();
  });

  it("still buffers an indented MEDIA directive line that is mid-stream", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    // Upstream parser treats `line.trimStart().startsWith("MEDIA:")` as a
    // directive, so the guard must also buffer the indented form across
    // a chunk boundary.
    const first = accumulator.consume("Preview:\n  MEDIA:/tmp/cover");
    expect(first?.text).toBe("Preview:");
    expect(first?.mediaUrls).toBeUndefined();

    const second = accumulator.consume(".png");
    expect(second).toBeNull();

    const finalResult = accumulator.consume("", { final: true });
    expect(finalResult?.mediaUrls).toEqual(["/tmp/cover.png"]);
  });

  it("does not rewrite mid-prose MEDIA into a directive across chunks", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    // A chunk can legitimately end with `MEDIA` mid-sentence (e.g. "this
    // uses legacy MEDIA"). A later chunk starting with `:` must NOT join
    // with the buffered token to synthesize a `MEDIA:<rest>` directive —
    // upstream `MEDIA_TOKEN_RE` captures `[^\n]+`, and treating the rest
    // of that sentence as a media path would invent a media reply the
    // agent never authored.
    const first = accumulator.consume("The legacy pipeline uses MEDIA");
    expect(first?.text).toBe("The legacy pipeline uses MEDIA");
    expect(first?.mediaUrls).toBeUndefined();

    const second = accumulator.consume(": kind=disk capacity=1TB");
    expect(second?.text).toBe(": kind=disk capacity=1TB");
    expect(second?.mediaUrls).toBeUndefined();
  });

  it("passes plain text through when there is no incomplete directive tail", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    const result = accumulator.consume("Hello world.\nThis is a complete block.");
    expect(result?.text).toBe("Hello world.\nThis is a complete block.");
    expect(result?.mediaUrls).toBeUndefined();
  });

  it("keeps MEDIA directives that arrive in a single complete chunk working", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    const result = accumulator.consume("Here it is.\n\nMEDIA:/tmp/complete.png\n");
    expect(result?.text.includes("MEDIA")).toBe(false);
    expect(result?.mediaUrls).toEqual(["/tmp/complete.png"]);
  });

  it("does not strip a complete final MEDIA line when parsing final text", () => {
    expect(splitTrailingDirective("Here.\nMEDIA:/tmp/final.png", { final: true })).toEqual({
      text: "Here.\nMEDIA:/tmp/final.png",
      tail: "",
    });
  });
});

describe("extractShortModelName", () => {
  it("normalizes provider/date/latest suffixes while preserving other IDs", () => {
    const cases = [
      ["openai-codex/gpt-5.4", "gpt-5.4"],
      ["claude-opus-4-6-20251101", "claude-opus-4-6"],
      ["gpt-5.4-latest", "gpt-5.4"],
      // Date suffix must be exactly 8 digits at the end.
      ["model-123456789", "model-123456789"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(extractShortModelName(input), input).toBe(expected);
    }
  });
});

describe("hasTemplateVariables", () => {
  it("handles empty, static, and repeated variable checks", () => {
    expect(hasTemplateVariables("")).toBe(false);
    expect(hasTemplateVariables("[{model}]")).toBe(true);
    expect(hasTemplateVariables("[{model}]")).toBe(true);
    expect(hasTemplateVariables("[Claude]")).toBe(false);
  });
});
