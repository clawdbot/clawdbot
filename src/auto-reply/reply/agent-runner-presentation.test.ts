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

function createPresentation(options: { isHeartbeat?: boolean; silentExpected?: boolean } = {}) {
  const turn = {
    followupRun: { run: { silentExpected: options.silentExpected === true } },
    isHeartbeat: options.isHeartbeat === true,
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
