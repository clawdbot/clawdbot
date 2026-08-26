import { buildReplyPayloads } from "../src/auto-reply/reply/agent-runner-payloads.js";

const text = "blank-media proof";
const target = {
  tool: "message",
  provider: "message",
  to: "268300329",
  text,
};
const baseParams = {
  isHeartbeat: false,
  didLogHeartbeatStrip: false,
  blockStreamingEnabled: false,
  blockReplyPipeline: null,
  replyToMode: "off" as const,
  messageProvider: "heartbeat",
  originatingTo: "268300329",
  messagingToolSentTexts: [text],
  messagingToolSentTargets: [target],
};

const build = (payload: { text: string; mediaUrl?: string; mediaUrls?: string[] }) =>
  buildReplyPayloads({ ...baseParams, payloads: [payload] });

const pluralBlank = await build({ text, mediaUrls: ["   "] });
const singularBlank = await build({ text, mediaUrl: "   " });
const realMedia = await build({ text, mediaUrl: "file:///tmp/photo.jpg", mediaUrls: ["   "] });
const passed =
  pluralBlank.replyPayloads.length === 0 &&
  singularBlank.replyPayloads.length === 0 &&
  realMedia.replyPayloads.length === 1;

console.log(
  JSON.stringify(
    {
      verdict: passed ? "PASS" : "FAIL",
      blankMedia: {
        pluralRetainedPayloads: pluralBlank.replyPayloads.length,
        singularRetainedPayloads: singularBlank.replyPayloads.length,
      },
      realMedia: {
        retainedPayloads: realMedia.replyPayloads.length,
        mediaUrl: realMedia.replyPayloads[0]?.mediaUrl,
      },
    },
    null,
    2,
  ),
);
if (!passed) {
  process.exitCode = 1;
}
