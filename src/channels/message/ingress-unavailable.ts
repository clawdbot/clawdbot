/**
 * Typed marker for "this channel cannot admit a single inbound event".
 *
 * Lives in its own module so the gateway supervisor can classify a channel
 * start failure without importing the whole ingress monitor onto its hot path.
 */
import { collectErrorGraphCandidates, extractErrorCode } from "../../infra/errors.js";

const CHANNEL_INGRESS_UNAVAILABLE_CODE = "CHANNEL_INGRESS_UNAVAILABLE";

/** Raised when a channel's durable ingress queue cannot be opened. */
export class ChannelIngressUnavailableError extends Error {
  readonly code = CHANNEL_INGRESS_UNAVAILABLE_CODE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChannelIngressUnavailableError";
  }
}

/**
 * Matches on the stable `code` across the whole `cause` chain rather than
 * `instanceof`. Channel plugins are free to wrap a start failure in their own
 * error, and duplicate module instances would defeat a prototype check.
 */
export function isChannelIngressUnavailableError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [current.cause]).some(
    (candidate) => extractErrorCode(candidate) === CHANNEL_INGRESS_UNAVAILABLE_CODE,
  );
}
