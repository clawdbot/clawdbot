// Gateway Protocol schema module defines source-agnostic desktop validation shapes.
import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { WorkerDesktopAppIdSchema } from "./environments.js";
import { NonEmptyString } from "./primitives.js";

// Desktop sources are additive; node and future source kinds append new union arms.
export const DesktopSourceSchema = Type.Union([
  closedObject({ kind: Type.Literal("host") }),
  closedObject({ kind: Type.Literal("environment"), environmentId: NonEmptyString }),
  closedObject({ kind: Type.Literal("node"), nodeId: NonEmptyString }),
]);

const DesktopObserveCredentialsSchema = closedObject({
  username: Type.Optional(NonEmptyString),
  password: Type.Optional(NonEmptyString),
});

export const DesktopObserveParamsSchema = Type.Union([
  closedObject({
    source: closedObject({ kind: Type.Literal("host") }),
    control: Type.Optional(Type.Boolean()),
    // Credentials exist only for this observe attempt and are never persisted or returned.
    credentials: Type.Optional(DesktopObserveCredentialsSchema),
  }),
  closedObject({
    source: closedObject({ kind: Type.Literal("environment"), environmentId: NonEmptyString }),
    control: Type.Optional(Type.Boolean()),
  }),
  closedObject({
    source: closedObject({ kind: Type.Literal("node"), nodeId: NonEmptyString }),
    control: Type.Optional(Type.Boolean()),
    credentials: Type.Optional(DesktopObserveCredentialsSchema),
  }),
]);

export const DesktopObserveResultSchema = closedObject({
  transport: Type.String({ enum: ["rfb"] }),
  wsPath: NonEmptyString,
  expiresAtMs: Type.Integer({ minimum: 0 }),
  control: Type.Boolean(),
  vncPassword: Type.Optional(NonEmptyString),
  // Auth drives credential prompting without coupling clients to RFB security numbers.
  auth: Type.Optional(Type.String({ enum: ["none", "vnc-password", "ard-account"] })),
  // Gateway-side pre-auth keeps credentials out of the browser RFB client.
  preauthenticated: Type.Optional(Type.Boolean()),
});

export const DesktopLaunchParamsSchema = closedObject({
  source: closedObject({ kind: Type.Literal("environment"), environmentId: NonEmptyString }),
  app: WorkerDesktopAppIdSchema,
});

export type DesktopSource = Static<typeof DesktopSourceSchema>;
export type DesktopObserveParams = Static<typeof DesktopObserveParamsSchema>;
export type DesktopObserveResult = Static<typeof DesktopObserveResultSchema>;
export type DesktopLaunchParams = Static<typeof DesktopLaunchParamsSchema>;
