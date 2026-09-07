// Connection-level chat attachment ceilings shared by the parser and the
// `hello-ok` handshake. Kept out of chat-attachments.ts so the handshake path
// does not pull the media probe/store graph in just to read two numbers.
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";

const DEFAULT_CHAT_ATTACHMENT_MAX_MB = 20;

// A chat.send frame carries attachments as base64 (4/3 expansion) plus the
// JSON envelope and message text. Advertising more than one WS frame can carry
// lets the client encode a payload the server hard-drops with 1009 for every
// pane — the exact failure the hello-ok policy exists to prevent.
const WS_FRAME_ENVELOPE_SLACK_BYTES = 256 * 1024;
const MAX_ADVERTISED_ATTACHMENT_BYTES = Math.floor(
  ((MAX_PAYLOAD_BYTES - WS_FRAME_ENVELOPE_SLACK_BYTES) * 3) / 4,
);

/** Default decoded-size ceiling when `agents.defaults.mediaMaxMb` is unset or invalid. */
export const DEFAULT_CHAT_ATTACHMENT_MAX_BYTES = DEFAULT_CHAT_ATTACHMENT_MAX_MB * 1024 * 1024;

/** Resolve the maximum decoded attachment size accepted for chat inputs. */
export function resolveChatAttachmentMaxBytes(cfg: OpenClawConfig): number {
  const configured = cfg.agents?.defaults?.mediaMaxMb;
  const mb =
    typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_CHAT_ATTACHMENT_MAX_MB;
  // mediaMaxMb only has to be positive, so a sub-byte value would floor to 0 and
  // a huge one overflows to Infinity, which serializes as null on the handshake
  // frame and fails its integer schema. Both ends have to stay representable.
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(mb * 1024 * 1024)));
}

/** Unconditional decoded-size ceilings advertised on `hello-ok.policy.attachments`. */
type ChatAttachmentPolicy = {
  maxBytes: number;
  maxImageBytes: number;
};

/**
 * Resolve the decoded-size ceilings every chat attachment faces regardless of
 * entrypoint or model. Images are checked against the configured ceiling first
 * and the agent-hydration cap second, so their effective limit is the smaller of
 * the two. MIME acceptance and per-message counts are deliberately absent: they
 * depend on the entrypoint, the resolved model, and payload sniffing, so they
 * cannot be stated once per connection.
 */
export function resolveChatAttachmentPolicy(cfg: OpenClawConfig): ChatAttachmentPolicy {
  const maxBytes = Math.min(resolveChatAttachmentMaxBytes(cfg), MAX_ADVERTISED_ATTACHMENT_BYTES);
  return { maxBytes, maxImageBytes: Math.min(maxBytes, MAX_IMAGE_BYTES) };
}
