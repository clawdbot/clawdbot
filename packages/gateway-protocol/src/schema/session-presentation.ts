import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Stable presentation category for a session row.
 *
 * These taxonomies remain open so a newer Gateway can add a presentation
 * category without making an otherwise compatible older client reject the row.
 */
export const SessionPresentationFamilySchema = NonEmptyString;
export const SessionPresentationTitleSourceSchema = NonEmptyString;
export const SessionPresentationPeerKindSchema = NonEmptyString;

/** Non-sensitive, client-ready identity and display metadata for a session row. */
export const SessionPresentationSchema = closedObject({
  title: NonEmptyString,
  titleSource: SessionPresentationTitleSourceSchema,
  subtitle: Type.Optional(NonEmptyString),
  family: SessionPresentationFamilySchema,
  agentId: Type.Optional(NonEmptyString),
  channel: Type.Optional(NonEmptyString),
  accountId: Type.Optional(NonEmptyString),
  peerKind: Type.Optional(SessionPresentationPeerKindSchema),
  isMain: Type.Boolean(),
  // Presentation classification only: it never changes visibility, sharing,
  // retention, or authorization semantics for the underlying session.
  isBackground: Type.Boolean(),
});

export type SessionPresentationFamily = Static<typeof SessionPresentationFamilySchema>;
export type SessionPresentationTitleSource = Static<typeof SessionPresentationTitleSourceSchema>;
export type SessionPresentation = Static<typeof SessionPresentationSchema>;
