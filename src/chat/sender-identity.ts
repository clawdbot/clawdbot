import { Value } from "typebox/value";
import {
  SessionParticipantIdentitySchema,
  type SessionParticipantIdentity,
} from "../../packages/gateway-protocol/src/schema/session-participant.js";

export type TranscriptSenderIdentity = Extract<
  SessionParticipantIdentity,
  { type: "profile" | "remote" | "observation" }
>;

/** Transcript attribution uses the closed product vocabulary, never raw-id inference. */
export function readTranscriptSenderIdentity(value: unknown): TranscriptSenderIdentity | undefined {
  if (
    !Value.Check(SessionParticipantIdentitySchema, value) ||
    (value.type !== "profile" && value.type !== "remote" && value.type !== "observation") ||
    Object.values(value).some((part) => part !== null && (!part.trim() || part.length > 512))
  ) {
    return undefined;
  }
  return { ...value };
}
