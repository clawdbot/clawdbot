/** Tests media-note behavior as it appears through reply prompt assembly. */
import { describe, expect, it } from "vitest";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import { buildReplyPromptEnvelope } from "./reply/prompt-prelude.js";

describe("getReplyFromConfig media note plumbing", () => {
  it("includes all MediaPaths in the agent prompt", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "hello",
      BodyForAgent: "hello",
      From: "+1001",
      To: "+2000",
      MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
      MediaUrls: ["/tmp/a.png", "/tmp/b.png"],
    });
    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: sessionCtx.BodyForAgent,
      hasUserBody: true,
      inboundUserContext: "",
      isBareSessionReset: false,
      startupAction: "new",
      prefixedBody: sessionCtx.BodyForAgent,
      sourceReplyDeliveryMode: "automatic",
    });
    const prompt = envelope.prefixedCommandBody;

    const mediaNote = [
      "[media attached: 2 files]",
      "[media attached 1/2: /tmp/a.png (application/octet-stream)]",
      "[media attached 2/2: /tmp/b.png (application/octet-stream)]",
    ].join("\n");
    expect(prompt).toBe(`${mediaNote}\nhello`);
    expect(envelope.queuedBody).toBe(`${mediaNote}\nhello`);
    expect(envelope.transcriptCommandBody).toBe(`${mediaNote}\nhello`);
    expect(prompt).not.toContain("message tool");
    expect(envelope.queuedBody).not.toContain("message tool");
    expect(envelope.media?.map(({ path }) => path)).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    const idxA = prompt.indexOf("[media attached 1/2: /tmp/a.png");
    const idxB = prompt.indexOf("[media attached 2/2: /tmp/b.png");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB);
    expect(prompt).toContain("hello");
  });

  it("keeps the real image attachment note after image understanding rewrites the body", () => {
    const describedBody = [
      "[Image]",
      "User text:",
      "make this widescreen",
      "Description:",
      "a red barn at sunset",
    ].join("\n");
    const sessionCtx = finalizeInboundContext({
      Body: describedBody,
      BodyForAgent: describedBody,
      From: "+1001",
      To: "+2000",
      MediaPaths: ["/tmp/media-store/real-image.png"],
      MediaUrls: ["https://example.com/real-image.png"],
      MediaTypes: ["image/png"],
      MediaUnderstanding: [
        {
          kind: "image.description",
          attachmentIndex: 0,
          text: "a red barn at sunset",
          provider: "openai",
        },
      ],
    });
    const prompt = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: sessionCtx.BodyForAgent,
      hasUserBody: true,
      inboundUserContext: "",
      isBareSessionReset: false,
      startupAction: "new",
      prefixedBody: sessionCtx.BodyForAgent,
    }).prefixedCommandBody;

    expect(prompt).toContain(
      "[media attached: /tmp/media-store/real-image.png (image/png) | https://example.com/real-image.png]",
    );
    expect(prompt).toContain(describedBody);
  });
});
