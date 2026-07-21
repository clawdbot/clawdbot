import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Stable presentation category for a session row. */
// Presentation taxonomies can grow independently of native clients. Keep their
// wire representation open so a newer Gateway cannot make an older client fail
// to decode an otherwise compatible sessions.list response.
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
  isBackground: Type.Boolean(),
});

export type SessionPresentationFamily = Static<typeof SessionPresentationFamilySchema>;
export type SessionPresentationTitleSource = Static<typeof SessionPresentationTitleSourceSchema>;
export type SessionPresentation = Static<typeof SessionPresentationSchema>;
