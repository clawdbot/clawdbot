import { optionalStringEnum } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

const BROWSER_EXEC_TARGETS = ["sandbox", "host", "node"] as const;

/** Provider-compatible Browser Exec arguments. */
export const BrowserExecToolSchema = Type.Object({
  code: Type.String(),
  target: optionalStringEnum(BROWSER_EXEC_TARGETS),
  node: Type.Optional(Type.String()),
  profile: Type.Optional(Type.String()),
  targetId: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

const BrowserExecErrorSchema = Type.Object(
  {
    name: Type.String(),
    message: Type.String(),
    stack: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Structured Browser Exec result. */
export const BrowserExecToolOutputSchema = Type.Object(
  {
    ok: Type.Boolean(),
    value: Type.Optional(Type.Unknown()),
    logs: Type.Array(Type.String()),
    error: Type.Optional(BrowserExecErrorSchema),
    timedOut: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
