/** Tests silent-reply and heartbeat token parsing helpers. */
import { describe, expect, it } from "vitest";
import {
  CONTINUE_WORK_TOKEN,
  HEARTBEAT_TOKEN,
  SILENT_REPLY_TOKEN,
  isInternalFormattingArtifact,
  isSilentReplyPrefixText,
  isSilentReplyPayloadText,
  isSilentReplyText,
  parseContinuationSignal,
  startsWithSilentToken,
  stripContinuationSignal,
  stripLeadingSilentToken,
  stripSilentToken,
} from "./tokens.js";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/* ------------------------------------------------------------------ */
/*  parseContinuationSignal                                           */
/* ------------------------------------------------------------------ */

describe("parseContinuationSignal", () => {
  it("returns null for undefined input", () => {
    expect(parseContinuationSignal(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseContinuationSignal("")).toBeNull();
  });

  it("returns null for normal text without signals", () => {
    expect(parseContinuationSignal("Hello, world!")).toBeNull();
  });

  it("returns null for text with signal-like words in the middle", () => {
    expect(parseContinuationSignal("I said CONTINUE_WORK but then kept talking")).toBeNull();
  });

  // --- CONTINUE_WORK (bare) ---

  it("parses bare CONTINUE_WORK at end of text", () => {
    const result = parseContinuationSignal("CONTINUE_WORK");
    expect(result).toEqual({ kind: "work", delayMs: undefined });
  });

  it("parses CONTINUE_WORK with leading whitespace", () => {
    const result = parseContinuationSignal("  CONTINUE_WORK  ");
    expect(result).toEqual({ kind: "work", delayMs: undefined });
  });

  it("parses CONTINUE_WORK after response text", () => {
    const result = parseContinuationSignal("I finished the first task.\nCONTINUE_WORK");
    expect(result).toEqual({ kind: "work", delayMs: undefined });
  });

  it("parses CONTINUE_WORK with trailing whitespace", () => {
    const result = parseContinuationSignal("Done for now. CONTINUE_WORK   ");
    expect(result).toEqual({ kind: "work", delayMs: undefined });
  });

  // --- CONTINUE_WORK with delay ---

  it("parses CONTINUE_WORK:30 with 30-second delay", () => {
    const result = parseContinuationSignal("CONTINUE_WORK:30");
    expect(result).toEqual({ kind: "work", delayMs: 30_000 });
  });

  it("parses CONTINUE_WORK:0 with zero delay", () => {
    const result = parseContinuationSignal("CONTINUE_WORK:0");
    expect(result).toEqual({ kind: "work", delayMs: 0 });
  });

  it("parses CONTINUE_WORK:120 after response text", () => {
    const result = parseContinuationSignal("Processing complete. CONTINUE_WORK:120");
    expect(result).toEqual({ kind: "work", delayMs: 120_000 });
  });

  it("parses CONTINUE_WORK:5 with trailing whitespace", () => {
    const result = parseContinuationSignal("CONTINUE_WORK:5  ");
    expect(result).toEqual({ kind: "work", delayMs: 5_000 });
  });

  // --- [[CONTINUE_DELEGATE: task]] (bracket syntax) ---

  it("parses [[CONTINUE_DELEGATE: task]] with simple task", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: run the tests]]");
    expect(result).toEqual({ kind: "delegate", task: "run the tests" });
  });

  it("parses [[CONTINUE_DELEGATE: task]] after response text", () => {
    const result = parseContinuationSignal(
      "I'll hand this off.\n[[CONTINUE_DELEGATE: review PR #42 and leave comments]]",
    );
    expect(result).toEqual({
      kind: "delegate",
      task: "review PR #42 and leave comments",
    });
  });

  it("parses [[CONTINUE_DELEGATE: multiline task]] naturally", () => {
    const result = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: first do X\nthen do Y\nfinally Z]]",
    );
    expect(result).toEqual({
      kind: "delegate",
      task: "first do X\nthen do Y\nfinally Z",
    });
  });

  it("trims whitespace from delegate task", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE:   check the logs   ]]");
    expect(result).toEqual({ kind: "delegate", task: "check the logs" });
  });

  it("rejects empty delegate task (whitespace only)", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE:    ]]");
    expect(result).toBeNull();
  });

  it("does not match bare CONTINUE_DELEGATE: without brackets", () => {
    const result = parseContinuationSignal("CONTINUE_DELEGATE:run the tests");
    expect(result).toBeNull();
  });

  it("does not match adversarial bare pattern with nested brackets (single-line)", () => {
    const result = parseContinuationSignal('CONTINUE_DELEGATE:[[[["bc annoying"]]]]');
    expect(result).toBeNull();
  });

  it("does not match adversarial bare pattern with nested brackets (multiline)", () => {
    const result = parseContinuationSignal('CONTINUE_DELEGATE:[[[["bc\nannoying"]]]]');
    expect(result).toBeNull();
  });

  it("does not match unclosed bracket", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: run the tests");
    expect(result).toBeNull();
  });

  it("does not match mid-text bracket directive followed by more content", () => {
    const result = parseContinuationSignal(
      "Use [[CONTINUE_DELEGATE: example]] to delegate.\nMore text here.",
    );
    expect(result).toBeNull();
  });

  it("matches only the LAST bracket directive when same token appears mid-text", () => {
    const result = parseContinuationSignal(
      "I used [[CONTINUE_DELEGATE: example]] earlier.\n[[CONTINUE_DELEGATE: real task]]",
    );
    expect(result).toEqual({ kind: "delegate", task: "real task" });
  });

  it("rejects ]] inside the task body", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: task with ]] inside]]");
    expect(result).toBeNull();
  });

  it("matches bracket directive at end after text", () => {
    const result = parseContinuationSignal(
      "I've finished the analysis.\n[[CONTINUE_DELEGATE: review the results]]",
    );
    expect(result).toEqual({ kind: "delegate", task: "review the results" });
  });

  it("handles extra whitespace inside brackets", () => {
    const result = parseContinuationSignal("[[  CONTINUE_DELEGATE:  do the thing  ]]");
    expect(result).toEqual({ kind: "delegate", task: "do the thing" });
  });

  it("handles trailing whitespace after closing bracket", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: task]]   ");
    expect(result).toEqual({ kind: "delegate", task: "task" });
  });

  // --- [[CONTINUE_DELEGATE: task +Ns]] (timed dispatch) ---

  it("parses [[CONTINUE_DELEGATE: task +5s]] with 5-second delay", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: run tests +5s]]");
    expect(result).toEqual({ kind: "delegate", task: "run tests", delayMs: 5000 });
  });

  it("parses [[CONTINUE_DELEGATE: task +30s]] with 30-second delay", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: review PR #42 +30s]]");
    expect(result).toEqual({ kind: "delegate", task: "review PR #42", delayMs: 30000 });
  });

  it("parses [[CONTINUE_DELEGATE: multiline task +10s]] with delay", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: first do X\nthen do Y +10s]]");
    expect(result).toEqual({ kind: "delegate", task: "first do X\nthen do Y", delayMs: 10000 });
  });

  it("parses [[CONTINUE_DELEGATE: task]] without delay as undefined delayMs", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: run tests]]");
    expect(result).toEqual({ kind: "delegate", task: "run tests", delayMs: undefined });
  });

  it("does not treat +Ns mid-task as a delay", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: wait +5s then do thing]]");
    expect(result).toEqual({
      kind: "delegate",
      task: "wait +5s then do thing",
      delayMs: undefined,
    });
  });

  it("handles +0s as zero delay", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: immediate +0s]]");
    expect(result).toEqual({ kind: "delegate", task: "immediate", delayMs: 0 });
  });

  // --- [[CONTINUE_DELEGATE: task | silent]] (silent enrichment) ---

  it("parses [[CONTINUE_DELEGATE: task | silent]] with silent flag", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: enrich context | silent]]");
    expect(result).toEqual({ kind: "delegate", task: "enrich context", silent: true });
  });

  it("parses [[CONTINUE_DELEGATE: task +15s | silent]] with delay and silent", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: think about X +15s | silent]]");
    expect(result).toEqual({
      kind: "delegate",
      task: "think about X",
      delayMs: 15000,
      silent: true,
    });
  });

  it("parses | silent case-insensitively", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: task | SILENT]]");
    expect(result).toEqual({ kind: "delegate", task: "task", silent: true });
  });

  it("does not set silent when | silent is not at end", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: check | silent | then report]]");
    // "| silent" is not at the end — the whole thing is the task
    expect(result?.kind === "delegate" && result.silent).toBeFalsy();
  });

  it("parses delegate without | silent as silent undefined", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: normal task]]");
    expect(result).toEqual({ kind: "delegate", task: "normal task" });
    expect(result?.kind === "delegate" ? result.silent : undefined).toBeUndefined();
  });

  // --- [[CONTINUE_DELEGATE: task | silent-wake]] (silent wake enrichment) ---

  it("parses [[CONTINUE_DELEGATE: task | silent-wake]] with silentWake flag", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: enrich context | silent-wake]]");
    expect(result).toEqual({ kind: "delegate", task: "enrich context", silentWake: true });
  });

  it("parses [[CONTINUE_DELEGATE: task +20s | silent-wake]] with delay and silentWake", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: chain hop 2 +20s | silent-wake]]");
    expect(result).toEqual({
      kind: "delegate",
      task: "chain hop 2",
      delayMs: 20000,
      silentWake: true,
    });
  });

  it("parses | silent-wake case-insensitively", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: task | SILENT-WAKE]]");
    expect(result).toEqual({ kind: "delegate", task: "task", silentWake: true });
  });

  it("parses | silent wake (space instead of hyphen)", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: task | silent wake]]");
    expect(result).toEqual({ kind: "delegate", task: "task", silentWake: true });
  });

  it("does not confuse | silent-wake with | silent", () => {
    const silentWake = parseContinuationSignal("[[CONTINUE_DELEGATE: task | silent-wake]]");
    const silent = parseContinuationSignal("[[CONTINUE_DELEGATE: task | silent]]");
    expect(silentWake?.kind === "delegate" && silentWake.silentWake).toBe(true);
    expect(silentWake?.kind === "delegate" ? silentWake.silent : undefined).toBeUndefined();
    expect(silent?.kind === "delegate" && silent.silent).toBe(true);
    expect(silent?.kind === "delegate" ? silent.silentWake : undefined).toBeUndefined();
  });

  it("parses delegate without suffix as neither silent nor silentWake", () => {
    const result = parseContinuationSignal("[[CONTINUE_DELEGATE: plain task]]");
    expect(result?.kind === "delegate" ? result.silent : undefined).toBeUndefined();
    expect(result?.kind === "delegate" ? result.silentWake : undefined).toBeUndefined();
  });

  it("consumes but ignores model-supplied traceparent directive options", () => {
    const result = parseContinuationSignal(
      `[[CONTINUE_DELEGATE: traced handoff | silent-wake | target=agent:main:root | traceparent=${VALID_TRACEPARENT}]]`,
    );

    expect(result).toEqual({
      kind: "delegate",
      task: "traced handoff",
      silentWake: true,
      targetSessionKey: "agent:main:root",
    });
  });

  it("ignores a missing traceparent directive value without rejecting the delegate", () => {
    const result = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: untraced handoff | traceparent=]]",
    );

    expect(result).toEqual({
      kind: "delegate",
      task: "untraced handoff",
    });
  });

  it("handles malformed traceparent directives without throwing or dropping the task", () => {
    expect(() =>
      parseContinuationSignal(
        "[[CONTINUE_DELEGATE: malformed traced handoff | silent | traceparent=not-a-traceparent]]",
      ),
    ).not.toThrow();

    const result = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: malformed traced handoff | silent | traceparent=not-a-traceparent]]",
    );
    expect(result).toEqual({
      kind: "delegate",
      task: "malformed traced handoff",
      silent: true,
    });
  });

  // --- Precedence ---

  it("prefers [[CONTINUE_DELEGATE:]] over CONTINUE_WORK when both present", () => {
    const result = parseContinuationSignal("CONTINUE_WORK\n[[CONTINUE_DELEGATE: do something]]");
    expect(result).toEqual({ kind: "delegate", task: "do something" });
  });

  // --- Regression: bracket in non-last payload (2026-03-28) ---
  // When tool calls interleave, the bracket token may be in a non-last payload.
  // The parser itself is correct (end-anchored regex matches), but agent-runner.ts
  // must scan backwards for the last TEXT-BEARING payload. This test documents
  // that the parser works when given the correct text fragment.
  // See: fix/2026.03.24-codex-review-findings commit 2b53fa4

  it("parses bracket delegate from text that would be a non-last payload (regression)", () => {
    // Simulates the text payload when tool calls follow:
    // payload[0] = { text: "Here's my response.\n[[CONTINUE_DELEGATE: task +3s]]" }
    // payload[1] = { toolCallId: "...", name: "exec", ... }  ← no .text
    // payload[2] = { toolResultId: "...", ... }               ← no .text
    // agent-runner must find payload[0], not payload[2]
    const textPayload = "Here's my response.\n[[CONTINUE_DELEGATE: chain-hop task +3s]]";
    const result = parseContinuationSignal(textPayload);
    expect(result).toEqual({
      kind: "delegate",
      task: "chain-hop task",
      delayMs: 3000,
      silent: undefined,
      silentWake: undefined,
    });
  });

  it("parses bracket delegate after multi-line response with emoji", () => {
    // Representative multi-line response with an emoji before the delegate token.
    const text =
      "✅ Test 2 passed.\nMoving to Test 5:\nBracket delegate dispatched. 🙂\n" +
      "[[CONTINUE_DELEGATE: Report back with 'bracket delegate confirmed' +3s]]";
    const result = parseContinuationSignal(text);
    expect(result).toEqual({
      kind: "delegate",
      task: "Report back with 'bracket delegate confirmed'",
      delayMs: 3000,
      silent: undefined,
      silentWake: undefined,
    });
  });
});

/* ------------------------------------------------------------------ */
/*  stripContinuationSignal                                           */
/* ------------------------------------------------------------------ */

describe("stripContinuationSignal", () => {
  it("returns original text and null signal when no signal present", () => {
    const result = stripContinuationSignal("Hello, world!");
    expect(result).toEqual({ text: "Hello, world!", signal: null });
  });

  it("strips bare CONTINUE_WORK from end, returns empty text", () => {
    const result = stripContinuationSignal("CONTINUE_WORK");
    expect(result.text).toBe("");
    expect(result.signal).toEqual({ kind: "work", delayMs: undefined });
  });

  it("strips CONTINUE_WORK from end of response, preserving visible text", () => {
    const result = stripContinuationSignal("I finished the task.\nCONTINUE_WORK");
    expect(result.text).toBe("I finished the task.");
    expect(result.signal).toEqual({ kind: "work", delayMs: undefined });
  });

  it("strips CONTINUE_WORK:60 and preserves preceding text", () => {
    const result = stripContinuationSignal("Processing batch 1/5. CONTINUE_WORK:60");
    expect(result.text).toBe("Processing batch 1/5.");
    expect(result.signal).toEqual({ kind: "work", delayMs: 60_000 });
  });

  it("strips [[CONTINUE_DELEGATE:]] and preserves preceding text", () => {
    const result = stripContinuationSignal(
      "I'll delegate this.\n[[CONTINUE_DELEGATE: run tests on PR #7]]",
    );
    expect(result.text).toBe("I'll delegate this.");
    expect(result.signal).toEqual({
      kind: "delegate",
      task: "run tests on PR #7",
    });
  });

  it("strips [[CONTINUE_DELEGATE:]] with multiline task", () => {
    const result = stripContinuationSignal(
      "Handing off.\n[[CONTINUE_DELEGATE: check CI\nreview the PR\nrun lint]]",
    );
    expect(result.text).toBe("Handing off.");
    expect(result.signal).toEqual({
      kind: "delegate",
      task: "check CI\nreview the PR\nrun lint",
    });
  });

  it("strips [[CONTINUE_DELEGATE:]] with timed delay suffix", () => {
    const result = stripContinuationSignal(
      "Scheduling review.\n[[CONTINUE_DELEGATE: review PR #42 +30s]]",
    );
    expect(result.text).toBe("Scheduling review.");
    expect(result.signal).toEqual({
      kind: "delegate",
      task: "review PR #42",
      delayMs: 30000,
    });
  });

  it("strips CONTINUE_WORK with trailing whitespace after signal", () => {
    const result = stripContinuationSignal("Done. CONTINUE_WORK   ");
    expect(result.text).toBe("Done.");
    expect(result.signal).toEqual({ kind: "work", delayMs: undefined });
  });

  it("handles only-whitespace text after stripping", () => {
    const result = stripContinuationSignal("  CONTINUE_WORK");
    expect(result.text).toBe("");
    expect(result.signal).toEqual({ kind: "work", delayMs: undefined });
  });
});

describe("isInternalFormattingArtifact", () => {
  it("matches Harmony channel markers (#88128)", () => {
    expect(isInternalFormattingArtifact("<channel|>")).toBe(true);
    expect(isInternalFormattingArtifact("  <channel|>  ")).toBe(true);
    expect(isInternalFormattingArtifact("\n<channel|>\n")).toBe(true);
    expect(isInternalFormattingArtifact("<channel|answer>")).toBe(true);
    expect(isInternalFormattingArtifact("<lane|reasoning>")).toBe(true);
    expect(isInternalFormattingArtifact("<|>")).toBe(true);
    expect(isInternalFormattingArtifact("<|channel|>")).toBe(true);
    expect(isInternalFormattingArtifact("<|message|>")).toBe(true);
    expect(isInternalFormattingArtifact("<|call|>")).toBe(true);
  });

  it("matches set-thought directives (#88128)", () => {
    expect(isInternalFormattingArtifact("set-thought <channel|>")).toBe(true);
    expect(isInternalFormattingArtifact("  set-thought <channel|>  ")).toBe(true);
    expect(isInternalFormattingArtifact("set-thought <lane|reasoning>")).toBe(true);
  });

  it("matches box-drawing HR separators (#88128)", () => {
    expect(isInternalFormattingArtifact("───")).toBe(true);
    expect(isInternalFormattingArtifact("─────────")).toBe(true);
    expect(isInternalFormattingArtifact("  ───  ")).toBe(true);
  });

  it("does NOT match generic markdown separators (avoids false positives)", () => {
    expect(isInternalFormattingArtifact("---")).toBe(false);
    expect(isInternalFormattingArtifact("___")).toBe(false);
    expect(isInternalFormattingArtifact("***")).toBe(false);
  });

  it("does NOT match generic XML-like tags (avoids false positives)", () => {
    expect(isInternalFormattingArtifact("<tag>")).toBe(false);
    expect(isInternalFormattingArtifact("</tag>")).toBe(false);
    expect(isInternalFormattingArtifact("<br/>")).toBe(false);
  });

  it("returns false for undefined/empty", () => {
    expect(isInternalFormattingArtifact(undefined)).toBe(false);
    expect(isInternalFormattingArtifact("")).toBe(false);
  });

  it("returns false for normal user-facing text", () => {
    expect(isInternalFormattingArtifact("Hello! How can I help?")).toBe(false);
    expect(isInternalFormattingArtifact("The answer is 42.")).toBe(false);
  });

  it("returns false for text that merely contains an artifact pattern", () => {
    expect(isInternalFormattingArtifact("Here are the options:\n───\n1. Option A")).toBe(false);
    expect(isInternalFormattingArtifact("Use <channel|> in your config.")).toBe(false);
    expect(isInternalFormattingArtifact("The set-thought mechanism works like this...")).toBe(
      false,
    );
  });

  it("returns false for code blocks and multi-line content", () => {
    expect(isInternalFormattingArtifact("```js\nconsole.log('hi')\n```")).toBe(false);
    expect(isInternalFormattingArtifact("**bold** and *italic* text")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  isSilentReplyText                                                 */
/* ------------------------------------------------------------------ */

describe("isSilentReplyText", () => {
  it("returns true for exact token", () => {
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
  });

  it("returns true for token with surrounding whitespace", () => {
    expect(isSilentReplyText("  NO_REPLY  ")).toBe(true);
    expect(isSilentReplyText("\nNO_REPLY\n")).toBe(true);
  });

  it("returns true for mixed-case token", () => {
    expect(isSilentReplyText("no_reply")).toBe(true);
    expect(isSilentReplyText("  No_RePlY  ")).toBe(true);
  });

  it("returns true for repeated token-only text separated by whitespace", () => {
    expect(isSilentReplyText("NO_REPLY\n\nNO_REPLY")).toBe(true);
    expect(isSilentReplyText("  no_reply \t No_RePlY  ")).toBe(true);
  });

  it("returns false for undefined/empty", () => {
    expect(isSilentReplyText(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isSilentReplyText("")).toBe(false);
  });

  it("returns true for exact NO_REPLY", () => {
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
  });

  it("returns true for NO_REPLY with leading whitespace", () => {
    expect(isSilentReplyText("  NO_REPLY")).toBe(true);
  });

  it("returns false for substantive text ending with NO_REPLY (#19537)", () => {
    // Substantive replies ending with NO_REPLY must NOT be silently dropped.
    // Only exact-match (entire message is NO_REPLY) should be treated as silent.
    expect(isSilentReplyText("Some text NO_REPLY")).toBe(false);
  });

  it("returns false for NO_REPLY embedded in a word", () => {
    // The regex uses \b word boundary, so embedded shouldn't match at suffix
    // But the prefix check just looks at start-of-string
    expect(isSilentReplyText("NOTNO_REPLY")).toBe(false);
  });

  it("returns true for HEARTBEAT_OK when token is overridden", () => {
    expect(isSilentReplyText("HEARTBEAT_OK", HEARTBEAT_TOKEN)).toBe(true);
  });

  it("returns true for NO_REPLY followed by newline", () => {
    expect(isSilentReplyText("NO_REPLY\n")).toBe(true);
  });

  it("returns false for normal conversational text", () => {
    expect(isSilentReplyText("Hello, how are you?")).toBe(false);
  });

  it.each([
    ".NO_REPLY",
    "*NO_REPLY",
    "...NO_REPLY",
    "NO_REPLY.",
    "NO_REPLY*",
    "NO_REPLY...",
    "*NO_REPLY*",
    '"NO_REPLY"',
    ".NO_REPLY.",
    " .NO_REPLY ",
    " NO_REPLY. ",
    " *NO_REPLY* ",
  ])("returns true for punctuation-wrapped token-only text: %j (#98166)", (text) => {
    expect(isSilentReplyText(text)).toBe(true);
  });

  it.each(["the sentinel is NO_REPLY, fyi", "💬NO_REPLY", "NO_REPLY👍"])(
    "keeps substantive punctuation or symbols: %j",
    (text) => {
      expect(isSilentReplyText(text)).toBe(false);
    },
  );

  it("preserves exact custom-token matches with punctuation-edged tokens", () => {
    // Custom tokens whose first/last character is punctuation must still match
    expect(isSilentReplyText("*SILENT*", "*SILENT*")).toBe(true);
    expect(isSilentReplyText("#QUIET#", "#QUIET#")).toBe(true);
    expect(isSilentReplyText("^^MUTE^^", "^^MUTE^^")).toBe(true);
  });
});

describe("isSilentReplyPayloadText", () => {
  it("returns true when leaked reasoning text ends in NO_REPLY", () => {
    expect(
      isSilentReplyPayloadText(
        "think\nCav is talking about a follow-up conversation.\nI will stay quiet here.NO_REPLY",
      ),
    ).toBe(true);
    expect(isSilentReplyPayloadText("think\ninternal reasoning\nNO_REPLY")).toBe(true);
    expect(isSilentReplyPayloadText("<think>internal reasoning</think>\nNO_REPLY")).toBe(true);
    expect(
      isSilentReplyPayloadText(
        "<think>internal reasoning</think>\nI will stay quiet here.NO_REPLY",
      ),
    ).toBe(true);
    expect(isSilentReplyPayloadText("<think>I will stay quiet here.NO_REPLY")).toBe(true);
  });

  it.each([
    ["closed", "<mm:think>internal reasoning</mm:think>\nNO_REPLY"],
    ["open", "<mm:think>internal reasoning\nNO_REPLY"],
  ])("returns true for %s MiniMax reasoning followed by NO_REPLY", (_kind, text) => {
    expect(isSilentReplyPayloadText(text)).toBe(true);
  });

  it("keeps substantive replies that also contain a trailing NO_REPLY token", () => {
    expect(isSilentReplyPayloadText("Here is a helpful response.\n\nNO_REPLY")).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "think\nHere is the actual answer.\nI will stay quiet here.NO_REPLY",
      ),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText("think\nCav is talking about a follow-up conversation.\nNO_REPLY"),
    ).toBe(false);
    expect(isSilentReplyPayloadText("analysis\nMeeting moved to 3 pm.\nNO_REPLY")).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "think\nThe user is asking whether the outage is resolved. Tell them the service is back up and they should retry.\nNO_REPLY",
      ),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText("<think>internal reasoning</think>\nHere is the answer.\nNO_REPLY"),
    ).toBe(false);
    expect(isSilentReplyPayloadText("think\nHere is the actual answer.\nNO_REPLY")).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "<think>internal reasoning</think>\nYou should not reply to that email.\nNO_REPLY",
      ),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText("<think>internal notes\nHere is the actual answer.\nNO_REPLY"),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "<think>internal reasoning</think>\nHere is the answer: I will stay quiet in the meeting, but you should still send the agenda.NO_REPLY",
      ),
    ).toBe(false);
  });
});

describe("stripSilentToken", () => {
  it("strips token from end of text", () => {
    expect(stripSilentToken("Done.\n\nNO_REPLY")).toBe("Done.");
  });

  it("does not strip token from start of text", () => {
    expect(stripSilentToken("NO_REPLY 👍")).toBe("NO_REPLY 👍");
  });

  it("strips token with emoji (#30916)", () => {
    expect(stripSilentToken("😄 NO_REPLY")).toBe("😄");
  });

  it("does not strip embedded token suffix without whitespace delimiter", () => {
    expect(stripSilentToken("interject.NO_REPLY")).toBe("interject.NO_REPLY");
  });

  it("strips only trailing occurrence", () => {
    expect(stripSilentToken("NO_REPLY ok NO_REPLY")).toBe("NO_REPLY ok");
  });

  it("returns empty string when only token remains", () => {
    expect(stripSilentToken("NO_REPLY")).toBe("");
    expect(stripSilentToken("  NO_REPLY  ")).toBe("");
  });

  it("strips token preceded by bold markdown formatting", () => {
    expect(stripSilentToken("**NO_REPLY")).toBe("");
    expect(stripSilentToken("some text **NO_REPLY")).toBe("some text");
    expect(stripSilentToken("reasoning**NO_REPLY")).toBe("reasoning");
  });
});

describe("custom silent tokens", () => {
  it.each([
    {
      name: "exact-token detection",
      check: () => isSilentReplyText("HEARTBEAT_OK", "HEARTBEAT_OK"),
      expected: true,
    },
    {
      name: "substantive text detection",
      check: () => isSilentReplyText("Checked inbox. HEARTBEAT_OK", "HEARTBEAT_OK"),
      expected: false,
    },
    {
      name: "repeated-token detection",
      check: () => isSilentReplyText("HEARTBEAT_OK\nHEARTBEAT_OK", "HEARTBEAT_OK"),
      expected: true,
    },
    {
      name: "trailing token stripping",
      check: () => stripSilentToken("done HEARTBEAT_OK", "HEARTBEAT_OK"),
      expected: "done",
    },
  ])("handles custom token for $name", ({ check, expected }) => {
    expect(check()).toBe(expected);
  });
});

/* ------------------------------------------------------------------ */
/*  isSilentReplyPrefixText                                           */
/* ------------------------------------------------------------------ */

describe("stripLeadingSilentToken", () => {
  it("strips glued leading token text", () => {
    expect(stripLeadingSilentToken("NO_REPLYThe user is saying")).toBe("The user is saying");
  });
});

describe("startsWithSilentToken", () => {
  it("matches leading glued silent tokens case-insensitively", () => {
    expect(startsWithSilentToken("NO_REPLYThe user is saying")).toBe(true);
    expect(startsWithSilentToken("No_RePlYThe user is saying")).toBe(true);
    expect(startsWithSilentToken("no_replyThe user is saying")).toBe(true);
  });

  it("rejects separated substantive prefixes and exact-token-only text", () => {
    expect(startsWithSilentToken("NO_REPLY -- nope")).toBe(false);
    expect(startsWithSilentToken("NO_REPLY: explanation")).toBe(false);
    expect(startsWithSilentToken("NO_REPLY—note")).toBe(false);
    expect(startsWithSilentToken("NO_REPLY")).toBe(false);
    expect(startsWithSilentToken("  NO_REPLY  ")).toBe(false);
  });
});

describe("isSilentReplyPrefixText", () => {
  it("matches uppercase token lead fragments", () => {
    expect(isSilentReplyPrefixText("NO")).toBe(true);
    expect(isSilentReplyPrefixText("NO_")).toBe(true);
    expect(isSilentReplyPrefixText("NO_RE")).toBe(true);
    expect(isSilentReplyPrefixText("NO_REPLY")).toBe(true);
    expect(isSilentReplyPrefixText("  HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects ambiguous natural-language prefixes", () => {
    expect(isSilentReplyPrefixText("N")).toBe(false);
    expect(isSilentReplyPrefixText("No")).toBe(false);
    expect(isSilentReplyPrefixText("no")).toBe(false);
    expect(isSilentReplyPrefixText("Hello")).toBe(false);
  });

  it("keeps underscore guard for non-NO_REPLY tokens", () => {
    expect(isSilentReplyPrefixText("HE", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEART", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects non-prefixes and mixed characters", () => {
    expect(isSilentReplyPrefixText("NO_X")).toBe(false);
    expect(isSilentReplyPrefixText("NO_REPLY more")).toBe(false);
    expect(isSilentReplyPrefixText("NO-")).toBe(false);
  });

  it("matches custom tokens with digits", () => {
    expect(isSilentReplyPrefixText("NOREPLY2", "NOREPLY2")).toBe(true);
    expect(isSilentReplyPrefixText("NOREPLY", "NOREPLY2")).toBe(false);
    expect(isSilentReplyPrefixText("NORE", "NOREPLY2")).toBe(false);
    expect(isSilentReplyPrefixText("NOR", "NOREPLY2")).toBe(false);
  });

  it("matches custom tokens with hyphens", () => {
    expect(isSilentReplyPrefixText("NO-ANSWER", "NO-ANSWER")).toBe(true);
    expect(isSilentReplyPrefixText("NO-AN", "NO-ANSWER")).toBe(true);
    expect(isSilentReplyPrefixText("NO-", "NO-ANSWER")).toBe(true);
  });

  it("rejects non-matching prefixes for custom tokens", () => {
    expect(isSilentReplyPrefixText("HE", "NOREPLY2")).toBe(false);
    expect(isSilentReplyPrefixText("HELLO", "NO-ANSWER")).toBe(false);
    expect(isSilentReplyPrefixText("NO-", "NOREPLY2")).toBe(false);
  });

  it("rejects pure-letter prefixes for punctuated tokens to avoid false suppression", () => {
    expect(isSilentReplyPrefixText("HE", "HELP-QUIET")).toBe(false);
    expect(isSilentReplyPrefixText("HELP", "HELP-QUIET")).toBe(false);
    expect(isSilentReplyPrefixText("HELP-", "HELP-QUIET")).toBe(true);
    expect(isSilentReplyPrefixText("HELP-QUIET", "HELP-QUIET")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Token constants                                                   */
/* ------------------------------------------------------------------ */

describe("token constants", () => {
  it("exports expected token values", () => {
    expect(HEARTBEAT_TOKEN).toBe("HEARTBEAT_OK");
    expect(SILENT_REPLY_TOKEN).toBe("NO_REPLY");
    expect(CONTINUE_WORK_TOKEN).toBe("CONTINUE_WORK");
  });
});
