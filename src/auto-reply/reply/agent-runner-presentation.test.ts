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
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";

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
  options: {
    isHeartbeat?: boolean;
    silentExpected?: boolean;
    onBlockReply?: (payload: ReplyPayload) => Promise<void>;
    blockReplyPipeline?: AgentTurnParams["blockReplyPipeline"];
  } = {},
) {
  const turn = {
    followupRun: { run: { silentExpected: options.silentExpected === true } },
    isHeartbeat: options.isHeartbeat === true,
    opts: options.onBlockReply ? { onBlockReply: options.onBlockReply } : undefined,
    sessionCtx: {},
    applyReplyToMode: (payload: ReplyPayload) => payload,
    typingSignals: { signalTextDelta: async () => {} },
    blockStreamingEnabled: true,
    blockReplyPipeline: options.blockReplyPipeline ?? null,
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

  it.each<{
    name: string;
    payload: ReplyPayload;
    delivered: boolean;
  }>([
    { name: "ordinary text", payload: { text: "private maintenance" }, delivered: false },
    {
      name: "orphaned tool image",
      payload: { mediaUrls: ["file:///tmp/private.png"] },
      delivered: false,
    },
    {
      name: "portable presentation",
      payload: {
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
        },
      },
      delivered: false,
    },
    {
      name: "legacy interactive controls",
      payload: {
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] }],
        },
      },
      delivered: false,
    },
    {
      name: "channel-specific action",
      payload: { channelData: { telegram: { buttons: [{ text: "Open" }] } } },
      delivered: false,
    },
    {
      name: "portable location",
      payload: { location: { latitude: 1, longitude: 2 } },
      delivered: false,
    },
    {
      name: "voice media exception",
      payload: { mediaUrls: ["file:///tmp/voice.opus"], audioAsVoice: true },
      delivered: true,
    },
    {
      name: "empty voice marker",
      payload: { audioAsVoice: true },
      delivered: false,
    },
    {
      name: "error exception",
      payload: { text: "maintenance failed", isError: true },
      delivered: true,
    },
  ])("applies the final silent-turn policy to streamed $name", async (testCase) => {
    for (const usePipeline of [false, true]) {
      const delivered: ReplyPayload[] = [];
      const blockReplyPipeline = usePipeline
        ? createBlockReplyPipeline({
            onBlockReply: async (payload) => {
              delivered.push(payload);
            },
            timeoutMs: 0,
          })
        : null;
      const presentation = createPresentation({
        silentExpected: true,
        onBlockReply: async (payload) => {
          delivered.push(payload);
        },
        blockReplyPipeline,
      });

      await presentation.blockReplyHandler?.(testCase.payload);
      await blockReplyPipeline?.flush({ force: true });

      expect(delivered, usePipeline ? "pipeline" : "direct").toHaveLength(
        testCase.delivered ? 1 : 0,
      );
      if (testCase.delivered) {
        expect(delivered[0]).toMatchObject(testCase.payload);
      }
    }
  });
});
