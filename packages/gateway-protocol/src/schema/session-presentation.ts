import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Stable presentation category for a session row. */
export const SessionPresentationFamilySchema = Type.Union([
  Type.Literal("main"),
  Type.Literal("direct"),
  Type.Literal("group"),
  Type.Literal("channel"),
  Type.Literal("thread"),
  Type.Literal("cron"),
  Type.Literal("heartbeat"),
  Type.Literal("subagent"),
  Type.Literal("acp"),
  Type.Literal("dashboard"),
  Type.Literal("tui"),
  Type.Literal("explicit"),
  Type.Literal("hook"),
  Type.Literal("harness"),
  Type.Literal("voice"),
  Type.Literal("dreaming"),
  Type.Literal("system"),
  Type.Literal("custom"),
  Type.Literal("global"),
  Type.Literal("unknown"),
]);

export const SessionPresentationTitleSourceSchema = Type.Union([
  Type.Literal("label"),
  Type.Literal("displayName"),
  Type.Literal("generated"),
  Type.Literal("worktree"),
]);

/** Non-sensitive, client-ready identity and display metadata for a session row. */
export const SessionPresentationSchema = closedObject({
  title: NonEmptyString,
  titleSource: SessionPresentationTitleSourceSchema,
  subtitle: Type.Optional(NonEmptyString),
  family: SessionPresentationFamilySchema,
  agentId: Type.Optional(NonEmptyString),
  channel: Type.Optional(NonEmptyString),
  accountId: Type.Optional(NonEmptyString),
  peerKind: Type.Optional(
    Type.Union([Type.Literal("direct"), Type.Literal("group"), Type.Literal("channel")]),
  ),
  isMain: Type.Boolean(),
  isBackground: Type.Boolean(),
});

export type SessionPresentationFamily = Static<typeof SessionPresentationFamilySchema>;
export type SessionPresentationTitleSource = Static<typeof SessionPresentationTitleSourceSchema>;
export type SessionPresentation = Static<typeof SessionPresentationSchema>;
