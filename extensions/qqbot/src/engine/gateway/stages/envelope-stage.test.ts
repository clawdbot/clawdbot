import { describe, expect, it } from "vitest";
import type { GroupMessageGateResult } from "../../group/message-gating.js";
import type { ProcessedAttachments } from "../inbound-attachments.js";
import type { InboundGroupInfo } from "../inbound-context.js";
import {
  buildDynamicCtx,
  buildGroupSystemPrompt,
  buildQuotePart,
  classifyMedia,
} from "./envelope-stage.js";

function makeGate(): GroupMessageGateResult {
  return { action: "pass", effectiveWasMentioned: true, shouldBypassMention: false };
}

function makeGroupInfo(partial: Partial<InboundGroupInfo["display"]> = {}): InboundGroupInfo {
  return {
    gate: makeGate(),
    activation: "mention",
    historyLimit: 50,
    isMerged: false,
    display: {
      groupName: "G",
      senderLabel: "S",
      ...partial,
    },
  };
}

describe("envelope-stage", () => {
  describe("buildQuotePart", () => {
    it("returns empty string when no replyTo", () => {
      expect(buildQuotePart(undefined)).toBe("");
    });

    it("wraps a quoted body in begin/end tags", () => {
      const out = buildQuotePart({ id: "R1", body: "hello", isQuote: true });
      expect(out).toContain("[Quoted message begins]");
      expect(out).toContain("hello");
      expect(out).toContain("[Quoted message ends]");
    });

    it("uses a fallback line when body is missing", () => {
      const out = buildQuotePart({ id: "R1", isQuote: true });
      expect(out).toContain("Original content unavailable");
    });
  });

  describe("buildDynamicCtx", () => {
    it("returns empty string when every list is empty", () => {
      expect(
        buildDynamicCtx({
          imageUrls: [],
          uniqueVoicePaths: [],
          uniqueVoiceUrls: [],
          uniqueVoiceAsrReferTexts: [],
        }),
      ).toBe("");
    });

    it("renders images / voice / asr when present", () => {
      const out = buildDynamicCtx({
        imageUrls: ["https://x/a.png", "https://x/b.png"],
        uniqueVoicePaths: ["/tmp/v.wav"],
        uniqueVoiceUrls: ["https://x/v.wav"],
        uniqueVoiceAsrReferTexts: ["hi", "there"],
      });
      expect(out).toContain("- Images: https://x/a.png, https://x/b.png");
      expect(out).toContain("- Voice: /tmp/v.wav, https://x/v.wav");
      expect(out).toContain("- ASR: hi | there");
      // Trailing blank line.
      expect(out.endsWith("\n\n")).toBe(true);
    });
  });

  describe("buildGroupSystemPrompt", () => {
    it("returns undefined when no prompts exist", () => {
      expect(buildGroupSystemPrompt("", undefined)).toBeUndefined();
    });

    it("joins accountSystemInstruction + introHint + behaviorPrompt", () => {
      const out = buildGroupSystemPrompt(
        "ACCOUNT",
        makeGroupInfo({ introHint: "INTRO", behaviorPrompt: "BEHAVIOR" }),
      );
      expect(out).toBe("ACCOUNT\nINTRO\nBEHAVIOR");
    });

    it("skips undefined parts cleanly", () => {
      const out = buildGroupSystemPrompt("", makeGroupInfo({ behaviorPrompt: "B" }));
      expect(out).toBe("B");
    });
  });

  describe("classifyMedia", () => {
    const emptyProcessed: ProcessedAttachments = {
      attachmentInfo: "",
      imageUrls: [],
      imageMediaTypes: [],
      voiceAttachmentPaths: [],
      voiceAttachmentUrls: [],
      voiceAsrReferTexts: [],
      voiceTranscripts: [],
      voiceTranscriptSources: [],
      attachmentLocalPaths: [],
    };

    it("separates local from remote image URLs", () => {
      const out = classifyMedia({
        ...emptyProcessed,
        imageUrls: ["/tmp/a.png", "https://x/b.png", "http://x/c.png"],
        imageMediaTypes: ["image/png", "image/jpeg", "image/gif"],
      });
      expect(out.localMediaPaths).toEqual(["/tmp/a.png"]);
      expect(out.remoteMediaUrls).toEqual(["https://x/b.png", "http://x/c.png"]);
      expect(out.remoteMediaTypes).toEqual(["image/jpeg", "image/gif"]);
    });

    it("defaults missing media type to image/png", () => {
      // When `imageMediaTypes[i]` is undefined (shorter than imageUrls),
      // the classifier substitutes a default.
      const out = classifyMedia({
        ...emptyProcessed,
        imageUrls: ["https://x/a.png"],
        imageMediaTypes: [],
      });
      expect(out.remoteMediaTypes).toEqual(["image/png"]);
    });

    it("dedupes voice paths and URLs", () => {
      const out = classifyMedia({
        ...emptyProcessed,
        voiceAttachmentPaths: ["/a", "/a", "/b"],
        voiceAttachmentUrls: ["u1", "u1"],
        voiceAsrReferTexts: ["x", "", "x"],
      });
      expect(out.uniqueVoicePaths).toEqual(["/a", "/b"]);
      expect(out.uniqueVoiceUrls).toEqual(["u1"]);
      expect(out.uniqueVoiceAsrReferTexts).toEqual(["x"]);
    });

    it("flags ASR fallback when transcriptSources contains 'asr'", () => {
      expect(
        classifyMedia({ ...emptyProcessed, voiceTranscriptSources: ["stt", "asr"] })
          .hasAsrReferFallback,
      ).toBe(true);
      expect(
        classifyMedia({ ...emptyProcessed, voiceTranscriptSources: ["stt"] }).hasAsrReferFallback,
      ).toBe(false);
    });
  });
});
