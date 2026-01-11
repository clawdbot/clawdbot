import { Type } from "@sinclair/typebox";

/**
 * Schema for initiating a voice call.
 */
export const InitiateCallSchema = Type.Object({
  /** Phone number to call (E.164 format, e.g., +15551234567) */
  to: Type.Optional(
    Type.String({
      description:
        "Phone number to call in E.164 format (e.g., +15551234567). If omitted, uses configured default.",
    }),
  ),
  /** Initial message to speak when call is answered */
  message: Type.String({
    description: "Message to speak when the call is answered.",
  }),
  /** Call mode: notify (deliver & hangup) or conversation (keep open) */
  mode: Type.Optional(
    Type.Union([Type.Literal("notify"), Type.Literal("conversation")], {
      description:
        "Call mode: 'notify' delivers message then auto-hangup, 'conversation' keeps call open for back-and-forth. Defaults to config setting.",
    }),
  ),
});

/**
 * Schema for continuing a call with follow-up.
 */
export const ContinueCallSchema = Type.Object({
  /** Call ID from initiate_call */
  callId: Type.String({
    description: "Call ID returned from initiate_call.",
  }),
  /** Message to speak and wait for response */
  message: Type.String({
    description: "Message to speak, then wait for user response.",
  }),
});

/**
 * Schema for speaking without waiting for response.
 */
export const SpeakToUserSchema = Type.Object({
  /** Call ID from initiate_call */
  callId: Type.String({
    description: "Call ID returned from initiate_call.",
  }),
  /** Message to speak */
  message: Type.String({
    description:
      "Message to speak to the user. Does not wait for response - use before long operations.",
  }),
});

/**
 * Schema for ending a call.
 */
export const EndCallSchema = Type.Object({
  /** Call ID to end */
  callId: Type.String({
    description: "Call ID to end.",
  }),
});

/**
 * Schema for getting call status.
 */
export const GetCallStatusSchema = Type.Object({
  /** Call ID to check */
  callId: Type.String({
    description: "Call ID to check status of.",
  }),
});
