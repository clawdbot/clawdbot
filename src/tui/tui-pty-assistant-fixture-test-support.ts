/** Generated-script fragment for assistant-specific PTY fixture messages. */
export const TUI_PTY_ASSISTANT_FIXTURE_SCRIPT = `
  function assistantMessageFromSourceReplyPayloads(
    payloads: ReturnType<typeof buildEmbeddedRunPayloads>,
  ) {
    if (payloads.length === 0) {
      throw new Error("expected source reply payload");
    }
    for (const payload of payloads) {
      const metadata = getReplyPayloadMetadata(payload);
      if (!metadata?.sourceReplyTranscriptMirror) {
        throw new Error("expected source reply transcript mirror metadata");
      }
      record("sourceReplyMetadata", metadata.sourceReplyTranscriptMirror);
    }
    const normalized = normalizeReplyPayloadsForDelivery(payloads);
    const content = normalized.flatMap((payload) => {
      const text = payload.text?.trim();
      return text ? [{ type: "text", text }] : [];
    });
    if (content.length === 0) {
      throw new Error("expected displayable source reply content");
    }
    return { role: "assistant", content, timestamp: Date.now() };
  }

  function buildAttachmentOnlyAssistantMessage(prompt: string, runId: string) {
    if (prompt !== "attachment-only assistant proof") {
      return null;
    }
    record("attachmentOnlyComplete", { runId });
    return {
      role: "assistant",
      content: [
        {
          type: "image",
          data: "SECRET_PTY_IMAGE_BYTES",
          url: "file:///Users/operator/private/image.png",
          artifactId: "SECRET_PTY_ARTIFACT",
        },
      ],
      timestamp: Date.now(),
    };
  }
`;
