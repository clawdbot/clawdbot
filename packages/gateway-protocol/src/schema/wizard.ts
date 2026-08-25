import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString, QrPngDataUrlSchema } from "./primitives.js";

/** Runtime state reported for gateway-driven setup wizard sessions. */
const WizardRunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("cancelled"),
  Type.Literal("error"),
]);

/** Starts a setup wizard, optionally scoped to a local or remote workspace. */
export const WizardStartParamsSchema = closedObject({
  mode: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
  workspace: Type.Optional(Type.String()),
  installDaemon: Type.Optional(Type.Boolean()),
  // "setup" (default) runs full onboarding; "channels" runs the guided
  // channel-setup flow (openclaw channels add) over the same step protocol.
  flow: Type.Optional(Type.Union([Type.Literal("setup"), Type.Literal("channels")])),
  // Preselected channel id for flow "channels" (e.g. "telegram").
  channel: Type.Optional(NonEmptyString),
});

/** Client answer payload for the current wizard step. */
export const WizardAnswerSchema = closedObject({
  stepId: NonEmptyString,
  value: Type.Optional(Type.Unknown()),
});

/** Advances a wizard session, with an answer when the previous step requested input. */
export const WizardNextParamsSchema = closedObject({
  sessionId: NonEmptyString,
  answer: Type.Optional(WizardAnswerSchema),
});

/** Shared session-id-only params for cancel and status requests. */
const WizardSessionIdParamsSchema = closedObject({
  sessionId: NonEmptyString,
});

/** Cancels an active wizard session. */
export const WizardCancelParamsSchema = WizardSessionIdParamsSchema;

/** Reads status for an active or recently completed wizard session. */
export const WizardStatusParamsSchema = WizardSessionIdParamsSchema;

/** Selectable value shown in a choice-based wizard step. */
const WizardStepOptionSchema = closedObject({
  value: Type.Unknown(),
  label: NonEmptyString,
  hint: Type.Optional(Type.String()),
});

const WizardDeviceCodeSchema = closedObject({
  code: NonEmptyString,
  expiresInMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
  message: Type.Optional(Type.String()),
});

/** Largest QR lifetime that every JavaScript timer owner can schedule safely. */
export const MAX_WIZARD_QR_EXPIRES_IN_MS = MAX_TIMER_TIMEOUT_MS;

const WizardQrStepSchema = closedObject({
  id: NonEmptyString,
  type: Type.Literal("qr"),
  title: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  qrDataUrl: QrPngDataUrlSchema,
  expiresInMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WIZARD_QR_EXPIRES_IN_MS })),
  canCancel: Type.Optional(Type.Boolean()),
  executor: Type.Literal("gateway"),
});

/** UI contract for one wizard step rendered by gateway clients. */
const WizardStepObjectSchema = Type.Object(
  {
    id: NonEmptyString,
    type: Type.Union([
      Type.Literal("note"),
      Type.Literal("select"),
      Type.Literal("text"),
      Type.Literal("confirm"),
      Type.Literal("multiselect"),
      Type.Literal("progress"),
      Type.Literal("action"),
      Type.Literal("qr"),
    ]),
    title: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    format: Type.Optional(Type.Union([Type.Literal("plain")])),
    options: Type.Optional(Type.Array(WizardStepOptionSchema)),
    initialValue: Type.Optional(Type.Unknown()),
    placeholder: Type.Optional(Type.String()),
    sensitive: Type.Optional(Type.Boolean()),
    executor: Type.Optional(Type.Union([Type.Literal("gateway"), Type.Literal("client")])),
    externalUrl: Type.Optional(Type.String()),
    deviceCode: Type.Optional(WizardDeviceCodeSchema),
    qrDataUrl: Type.Optional(QrPngDataUrlSchema),
    expiresInMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WIZARD_QR_EXPIRES_IN_MS })),
    canCancel: Type.Optional(Type.Boolean()),
  },
  {
    additionalProperties: false,
    if: Type.Object({ type: Type.Literal("qr") }),
    // oxlint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema keyword.
    then: WizardQrStepSchema,
    else: {
      not: {
        anyOf: [
          { required: ["qrDataUrl"] },
          { required: ["expiresInMs"] },
          { required: ["canCancel"] },
        ],
      },
    },
  },
);

type WizardStepWire = Static<typeof WizardStepObjectSchema>;
type WizardNonQrStep = Omit<WizardStepWire, "type" | "qrDataUrl" | "expiresInMs" | "canCancel"> & {
  type: Exclude<WizardStepWire["type"], "qr">;
  qrDataUrl?: never;
  expiresInMs?: never;
  canCancel?: never;
};
type WizardQrStepWire = Static<typeof WizardQrStepSchema>;
type WizardQrStep = WizardQrStepWire & {
  [Field in Exclude<keyof WizardStepWire, keyof WizardQrStepWire>]?: never;
};
export type WizardStep = WizardNonQrStep | WizardQrStep;

// Native generators need one object schema; the static type keeps the QR variant closed.
export const WizardStepSchema = Type.Unsafe<WizardStep>(WizardStepObjectSchema);

/** Channel/account pair the channels flow actually configured. */
const WizardConfiguredAccountSchema = closedObject({
  channel: NonEmptyString,
  accountId: NonEmptyString,
});

/** Common response fields for start and next calls. */
const WizardResultFields = {
  done: Type.Boolean(),
  step: Type.Optional(WizardStepSchema),
  status: Type.Optional(WizardRunStatusSchema),
  error: Type.Optional(Type.String()),
  // What the flow actually configured; set on the terminal result of
  // wizard.start flow "channels" sessions so clients run channel-specific
  // completion (e.g. WhatsApp QR linking for the right account) from the
  // real outcome rather than the preselection.
  channels: Type.Optional(Type.Array(NonEmptyString)),
  accounts: Type.Optional(Type.Array(WizardConfiguredAccountSchema)),
  // Exact model prepared by provider-owned setup. Clients must still run the
  // live activation step before presenting the route as ready.
  preparedModelRef: Type.Optional(NonEmptyString),
};

/** Result after advancing a wizard session. */
export const WizardNextResultSchema = closedObject(WizardResultFields);

/** Result returned when a wizard session is created. */
export const WizardStartResultSchema = closedObject({
  sessionId: NonEmptyString,
  ...WizardResultFields,
});

/** Minimal status poll result used when the client does not need the next step. */
export const WizardStatusResultSchema = closedObject({
  status: WizardRunStatusSchema,
  error: Type.Optional(Type.String()),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type WizardStartParams = Static<typeof WizardStartParamsSchema>;
export type WizardAnswer = Static<typeof WizardAnswerSchema>;
export type WizardNextParams = Static<typeof WizardNextParamsSchema>;
export type WizardCancelParams = Static<typeof WizardCancelParamsSchema>;
export type WizardStatusParams = Static<typeof WizardStatusParamsSchema>;
export type WizardNextResult = Static<typeof WizardNextResultSchema>;
export type WizardStartResult = Static<typeof WizardStartResultSchema>;
export type WizardStatusResult = Static<typeof WizardStatusResultSchema>;
