import { isDeepStrictEqual } from "node:util";

const CANONICAL_SEEDED_ATTACHMENT = {
  type: "openclaw_media",
  media: {
    url: "media://inbound/seeded-image.png",
    contentType: "image/png",
    kind: "image",
    fileName: "seeded-image.png",
    sizeBytes: 3,
    transcribed: false,
  },
};

const LEGACY_SEEDED_ATTACHMENT = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "abc" },
};

/** Match the candidate's persisted-media contract selected by the trusted Docker harness. */
export function hasExpectedSeededMcpAttachment(attachment, frozenTarget) {
  return isDeepStrictEqual(
    attachment,
    frozenTarget ? LEGACY_SEEDED_ATTACHMENT : CANONICAL_SEEDED_ATTACHMENT,
  );
}
