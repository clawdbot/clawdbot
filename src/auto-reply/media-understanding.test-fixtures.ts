import type { MediaUnderstandingDecision } from "../media-understanding/types.js";

function createSuccessfulMediaDecision(
  capability: "audio" | "image" | "video",
): MediaUnderstandingDecision {
  return {
    capability,
    outcome: "success",
    attachments: [
      {
        attachmentIndex: 0,
        attempts: [
          {
            type: "provider",
            outcome: "success",
            provider: "openai",
            model: "gpt-5.4",
          },
        ],
        chosen: {
          type: "provider",
          outcome: "success",
          provider: "openai",
          model: "gpt-5.4",
        },
      },
    ],
  };
}

export function createSuccessfulAudioMediaDecision() {
  return createSuccessfulMediaDecision("audio");
}

export function createSuccessfulImageMediaDecision() {
  return createSuccessfulMediaDecision("image");
}
