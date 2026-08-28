import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { describe, expect, it } from "vitest";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { createAgentTurnPresentation } from "./agent-runner-presentation.js";

function normalizeStreamingTextReference(
  payload: ReplyPayload,
  options: { isHeartbeat?: boolean; silentExpected?: boolean } = {},
): { text?: string; skip: boolean } {
  let text = payload.text;
  const reply = resolveSendableOutboundReplyParts(payload);
  if (options.silentExpected) {
    return { skip: true };
  }
  if (!options.isHeartbeat && text?.includes("HEARTBEAT_OK")) {
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    if (stripped.shouldSkip && !reply.hasMedia) {
      return { skip: true };
    }
    text = stripped.text;
  }
  if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
    return { skip: true };
  }
  if (
    isSilentReplyPrefixText(text, SILENT_REPLY_TOKEN) ||
    isSilentReplyPrefixText(text, HEARTBEAT_TOKEN)
  ) {
    return { skip: true };
  }
  if (text && startsWithSilentToken(text, SILENT_REPLY_TOKEN)) {
    text = stripLeadingSilentToken(text, SILENT_REPLY_TOKEN);
  }
  if (!text) {
    return reply.hasMedia ? { text: undefined, skip: false } : { skip: true };
  }
  const sanitized = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
  return sanitized.trim() ? { text: sanitized, skip: false } : { skip: true };
}

function createPresentation(
  options: { isHeartbeat?: boolean; silentExpected?: boolean; conversationContext?: string } = {},
) {
  const turn = {
    followupRun: { run: { silentExpected: options.silentExpected === true } },
    isHeartbeat: options.isHeartbeat === true,
    sessionCtx: { agentText: options.conversationContext },
    opts: undefined,
  } as unknown as AgentTurnParams;
  return createAgentTurnPresentation({
    turn,
    replyMediaContext: { normalizePayload: async (payload) => payload },
    directlySentBlockKeys: new Set(),
    directlySentBlockPayloads: [],
    heartbeatState: { didLogStrip: false },
  });
}

function cumulativePrefixes(text: string, seed: number): string[] {
  const prefixes: string[] = [];
  let offset = 0;
  let random = seed >>> 0;
  while (offset < text.length) {
    random = (random * 1_664_525 + 1_013_904_223) >>> 0;
    offset = Math.min(text.length, offset + 1 + (random % 7));
    prefixes.push(text.slice(0, offset));
  }
  return prefixes;
}

describe("agent runner streaming presentation", () => {
  it("redacts copied inbound prompts before streamed XML cleanup", () => {
    const conversationContext = [
      "[Chat messages since your last reply - for context]",
      "Alice: private history",
      "",
      "[Current message - respond to this]",
      '<function_calls><invoke name="exec">private XML</invoke></function_calls>',
      "private inbound paragraph",
    ].join("\n");
    const presentation = createPresentation({ conversationContext });

    expect(
      presentation.normalizeStreamingText({
        text: `${conversationContext}\n\nVisible streamed answer.`,
      }),
    ).toEqual({ text: "Visible streamed answer.", skip: false });
  });

  it("withholds cumulative copied-prompt prefixes before any private stream text is visible", () => {
    const conversationContext = [
      "[Chat messages since your last reply - for context]",
      "Alice: private history",
      "",
      "[Current message - respond to this]",
      "private inbound paragraph",
    ].join("\n");
    const presentation = createPresentation({ conversationContext });

    for (const length of [1, 9, 50, 74, conversationContext.length - 1]) {
      expect(
        presentation.normalizeStreamingText({ text: conversationContext.slice(0, length) }),
      ).toEqual({
        skip: true,
      });
    }

    expect(
      presentation.normalizeStreamingText({
        text: `${conversationContext}\n\nVisible streamed answer.`,
      }),
    ).toEqual({ text: "Visible streamed answer.", skip: false });
  });

  it.each([
    { name: "standard", prefix: "> " },
    { name: "indented", prefix: "  > " },
    { name: "nested", prefix: ">> " },
    { name: "spaced nested", prefix: "> > " },
    { name: "four-space code", prefix: "    " },
    { name: "tab-indented code", prefix: "\t" },
    { name: "bulleted list", prefix: "- " },
    { name: "numbered list", prefix: "1. " },
    { name: "heading", prefix: "# " },
    { name: "deep heading", prefix: "###### " },
    { name: "quoted heading", prefix: "> ## " },
    { name: "multiline list item", prefix: "- ", continuation: "  " },
    { name: "widely indented list item", prefix: "- ", continuation: "    " },
    { name: "varying quote depth", prefix: "> ", continuation: ">> " },
    { name: "quoted list continuation", prefix: "> - ", continuation: ">   " },
    { name: "mixed code indentation", prefix: "    ", continuation: "\t" },
    { name: "quoted continuation after an unwrapped marker", prefix: "", continuation: "> " },
    { name: "very wide list continuation", prefix: "- ", continuation: " ".repeat(320) },
    { name: "deeply nested quote", prefix: "> ", continuation: `${">".repeat(320)} ` },
  ])(
    "withholds $name Markdown prompt bytes before private stream text is visible",
    ({ prefix, continuation }) => {
      const conversationContext = [
        "[Chat messages since your last reply - for context]",
        "Alice: private history",
        "",
        "[Current message - respond to this]",
        "private inbound paragraph",
      ].join("\n");
      const quotedContext = conversationContext
        .split("\n")
        .map((line, index) => `${index === 0 ? prefix : (continuation ?? prefix)}${line}`)
        .join("\n");
      const presentation = createPresentation({ conversationContext });

      for (let length = 1; length <= quotedContext.length; length += 1) {
        const visibleText =
          presentation.normalizeStreamingText({ text: quotedContext.slice(0, length) }).text ?? "";

        expect(visibleText).not.toContain("Alice");
        expect(visibleText).not.toContain("private inbound");
      }

      expect(
        presentation.normalizeStreamingText({
          text: `${quotedContext}\n\nVisible streamed answer.`,
        }),
      ).toEqual({ text: "Visible streamed answer.", skip: false });
    },
  );

  it("withholds decorated prompt continuations after safe same-line reply text", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "private inbound paragraph",
    ].join("\n");
    const wrappedContext = conversationContext
      .split("\n")
      .map((line, index) => `${index === 0 ? "Visible answer: " : "> "}${line}`)
      .join("\n");
    const presentation = createPresentation({ conversationContext });

    for (let length = 1; length <= wrappedContext.length; length += 1) {
      const visibleText =
        presentation.normalizeStreamingText({ text: wrappedContext.slice(0, length) }).text ?? "";

      expect(visibleText).not.toContain("private");
    }
  });

  it("withholds every copied prompt prefix with bare carriage-return separators", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "private inbound paragraph",
    ].join("\n");
    const copiedContext = conversationContext.replace(/\n/g, "\r");
    const presentation = createPresentation({ conversationContext });

    for (let length = 1; length <= copiedContext.length; length += 1) {
      const visibleText =
        presentation.normalizeStreamingText({ text: copiedContext.slice(0, length) }).text ?? "";

      expect(visibleText).not.toContain("private");
    }

    expect(
      presentation.normalizeStreamingText({ text: `${copiedContext}\n\nVisible answer.` }),
    ).toEqual({ text: "Visible answer.", skip: false });
  });

  it("keeps the original prompt anchor when private context repeats its first marker", () => {
    const marker = "[Current message - respond to this]";
    const conversationContext = [
      marker,
      "private first paragraph",
      marker,
      "private final paragraph",
    ].join("\n");
    const wrappedContext = conversationContext
      .split("\n")
      .map((line, index) => `${index === 0 ? "- " : " ".repeat(320)}${line}`)
      .join("\n");
    const presentation = createPresentation({ conversationContext });

    for (let length = 1; length <= wrappedContext.length; length += 1) {
      const visibleText =
        presentation.normalizeStreamingText({ text: wrappedContext.slice(0, length) }).text ?? "";

      expect(visibleText).not.toContain("private");
    }
  });

  it("preserves bracket-heavy streamed text without treating every bracket as a prompt", () => {
    const marker = "[Current message - respond to this]";
    const conversationContext = `${marker}\nprivate inbound paragraph`;
    const visibleText = `${marker}${"[".repeat(40_000)}`;
    const presentation = createPresentation({ conversationContext });

    const result = presentation.normalizeStreamingText({ text: visibleText });

    expect(result.skip).toBe(false);
    expect(result.text?.length).toBe(visibleText.length - 1);
    expect(result.text?.startsWith(marker)).toBe(true);
  });

  it("withholds repeated prompt markers before their private streaming continuation", () => {
    const marker = "[Current message - respond to this]";
    const conversationContext = `${marker}\nprivate inbound paragraph`;
    const presentation = createPresentation({ conversationContext });
    const repeatedMarkers = `${marker}\n`.repeat(32);

    for (const privatePrefix of ["private", "private inbound"]) {
      const visibleText =
        presentation.normalizeStreamingText({ text: `${repeatedMarkers}${privatePrefix}` }).text ??
        "";

      expect(visibleText).not.toContain("private");
    }
  });

  it.each([
    { name: "bulleted", prefix: "- ", sourcePrefix: "- " },
    { name: "quoted", prefix: "> ", sourcePrefix: "> " },
    { name: "indented", prefix: "    ", sourcePrefix: "    " },
    {
      name: "list continuation with prompt indentation",
      prefix: "- ",
      continuation: "    ",
      sourcePrefix: "    ",
    },
    {
      name: "list continuation with a prompt-owned bullet",
      prefix: "- ",
      continuation: "    ",
      sourcePrefix: "- ",
    },
    {
      name: "varying quote depth with a prompt-owned quote",
      prefix: "> ",
      continuation: ">> ",
      sourcePrefix: "> ",
    },
  ])(
    "withholds $name wrappers without consuming prompt-owned Markdown",
    ({ prefix, continuation, sourcePrefix }) => {
      const conversationContext = [
        "[Current message - respond to this]",
        `${sourcePrefix}private inbound paragraph`,
      ].join("\n");
      const wrappedContext = conversationContext
        .split("\n")
        .map((line, index) => `${index === 0 ? prefix : (continuation ?? prefix)}${line}`)
        .join("\n");
      const presentation = createPresentation({ conversationContext });

      for (let length = 1; length <= wrappedContext.length; length += 1) {
        const visibleText =
          presentation.normalizeStreamingText({ text: wrappedContext.slice(0, length) }).text ?? "";

        expect(visibleText).not.toContain("private");
      }
    },
  );

  it("withholds a trailing copied-prompt prefix without hiding safe preceding streamed text", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "private inbound paragraph",
    ].join("\n");
    const presentation = createPresentation({ conversationContext });

    expect(
      presentation.normalizeStreamingText({
        text: `Safe introductory answer.\n${conversationContext.slice(0, 12)}`,
      }),
    ).toEqual({ text: "Safe introductory answer.\n", skip: false });

    expect(
      presentation.normalizeStreamingText({
        text: `Safe introductory answer: ${conversationContext.slice(0, 12)}`,
      }),
    ).toEqual({ text: "Safe introductory answer: ", skip: false });

    expect(
      presentation.normalizeStreamingText({
        text: `\`\`\`text\n${conversationContext.slice(0, 12)}`,
      }),
    ).toEqual({ text: "```text\n", skip: false });
  });

  it("keeps long newline-heavy answers visible without copying every remaining line suffix", () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "private inbound paragraph",
    ].join("\n");
    const visibleAnswer = Array.from({ length: 2_000 }, (_, index) => `Visible line ${index}`).join(
      "\n",
    );
    const presentation = createPresentation({ conversationContext });

    expect(presentation.normalizeStreamingText({ text: visibleAnswer })).toEqual({
      text: visibleAnswer,
      skip: false,
    });
  });

  it("keeps split classification and sanitization equivalent to the eager path", () => {
    const presentation = createPresentation();
    const randomSequences = Array.from({ length: 16 }, (_, index) =>
      cumulativePrefixes(
        `Randomized answer ${index + 1}: alpha beta gamma delta epsilon.`,
        0xc0ffee + index,
      ).map((text) => ({ text })),
    );
    const sequences: ReplyPayload[][] = [
      ...randomSequences,
      cumulativePrefixes("HEARTBEAT_OK visible after heartbeat", 41).map((text) => ({ text })),
      ["N", "NO_", "NO_REPLY"].map((text) => ({ text })),
      [{ text: "NO_REPLYVisible" }, { text: "NO_REPLYVisible answer" }],
      [" ", "  ", "  \n"].map((text) => ({ text })),
      [{ text: "[tool calls omitted]" }],
      [{ mediaUrls: ["https://example.invalid/image.png"] }],
    ];

    for (const partials of sequences) {
      for (const payload of partials) {
        const expected = normalizeStreamingTextReference(payload);
        const classified = presentation.classifyStreamingPartial(payload);
        const actual =
          classified.skip || !classified.text
            ? classified
            : presentation.sanitizeStreamingText(classified.text, Boolean(payload.isError));
        expect(actual).toEqual(expected);
      }
    }
  });

  it("keeps silent-expected and heartbeat-run classification eager", () => {
    const silentPresentation = createPresentation({ silentExpected: true });
    expect(silentPresentation.classifyStreamingPartial({ text: "visible" })).toEqual({
      skip: true,
    });

    const heartbeatPresentation = createPresentation({ isHeartbeat: true });
    expect(
      heartbeatPresentation.classifyStreamingPartial({ text: "HEARTBEAT_OK details" }),
    ).toEqual({
      text: "HEARTBEAT_OK details",
      skip: false,
    });
  });
});
