import type { Static } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Stable, non-sensitive classification for a session row.
 *
 * The taxonomy remains open so newer Gateways can add classifications without
 * making otherwise compatible older clients reject the row.
 */
export const SessionClassificationSchema = NonEmptyString;

/** Non-sensitive peer category derived from the session route, when known. */
export const SessionPeerKindSchema = NonEmptyString;

export type SessionClassification = Static<typeof SessionClassificationSchema>;
export type SessionPeerKind = Static<typeof SessionPeerKindSchema>;
