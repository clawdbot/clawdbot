// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { GatewayClientIdSchema, GatewayClientModeSchema, NonEmptyString } from "./primitives.js";
import { SnapshotSchema, StateVersionSchema } from "./snapshot.js";

export const GATEWAY_SERVER_CAPS = {
  BOARD_WIDGET_PUT_CANVAS_DOC: "board-widget-put-canvas-doc",
  CHAT_SEND_ROUTING_CONTRACT: "chat-send-routing-contract",
  SYSTEM_AGENT_SETUP_MODEL_REF: "openclaw-setup-model-ref",
} as const;

/**
 * Top-level gateway frame schemas.
 *
 * These are the WebSocket envelope contracts; method/event payload schemas live
 * in feature-specific modules and are referenced by runtime validators.
 */
/** Periodic server heartbeat event payload. */
export const TickEventSchema = closedObject({
  ts: Type.Integer({ minimum: 0 }),
});

/** Server shutdown notice event payload. */
export const ShutdownEventSchema = closedObject({
  reason: NonEmptyString,
  restartExpectedMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** Initial client hello/connect payload sent before the gateway accepts frames. */
export const ConnectParamsSchema = closedObject({
  minProtocol: Type.Integer({ minimum: 1 }),
  maxProtocol: Type.Integer({ minimum: 1 }),
  client: closedObject({
    id: GatewayClientIdSchema,
    displayName: Type.Optional(NonEmptyString),
    version: NonEmptyString,
    platform: NonEmptyString,
    deviceFamily: Type.Optional(NonEmptyString),
    modelIdentifier: Type.Optional(NonEmptyString),
    mode: GatewayClientModeSchema,
    instanceId: Type.Optional(NonEmptyString),
  }),
  caps: Type.Optional(Type.Array(NonEmptyString, { default: [] })),
  commands: Type.Optional(Type.Array(NonEmptyString)),
  permissions: Type.Optional(Type.Record(NonEmptyString, Type.Boolean())),
  pathEnv: Type.Optional(Type.String()),
  role: Type.Optional(NonEmptyString),
  scopes: Type.Optional(Type.Array(NonEmptyString)),
  device: Type.Optional(
    closedObject({
      id: NonEmptyString,
      publicKey: NonEmptyString,
      signature: NonEmptyString,
      signedAt: Type.Integer({ minimum: 0 }),
      nonce: NonEmptyString,
    }),
  ),
  auth: Type.Optional(
    closedObject({
      token: Type.Optional(Type.String()),
      bootstrapToken: Type.Optional(Type.String()),
      deviceToken: Type.Optional(Type.String()),
      password: Type.Optional(Type.String()),
      approvalRuntimeToken: Type.Optional(Type.String()),
      agentRuntimeIdentityToken: Type.Optional(Type.String()),
    }),
  ),
  locale: Type.Optional(Type.String()),
  userAgent: Type.Optional(Type.String()),
});

/** Successful gateway hello response with negotiated protocol and initial state. */
export const HelloOkSchema = closedObject({
  type: Type.Literal("hello-ok"),
  protocol: Type.Integer({ minimum: 1 }),
  server: closedObject({
    version: NonEmptyString,
    connId: NonEmptyString,
  }),
  features: closedObject({
    methods: Type.Array(NonEmptyString),
    events: Type.Array(NonEmptyString),
    capabilities: Type.Optional(Type.Array(NonEmptyString)),
  }),
  snapshot: SnapshotSchema,
  // Additive: plugin-declared Control UI tabs (surface "tab" descriptors).
  controlUiTabs: Type.Optional(
    Type.Array(
      closedObject({
        pluginId: NonEmptyString,
        id: NonEmptyString,
        label: NonEmptyString,
        description: Type.Optional(Type.String()),
        icon: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
        requiresGatewayAuth: Type.Optional(Type.Boolean()),
        group: Type.Optional(Type.Union([Type.Literal("control"), Type.Literal("agent")])),
        order: Type.Optional(Type.Number()),
      }),
    ),
  ),
  // Additive: active plugin widget kinds whose renderers ship in the trusted UI bundle.
  controlUiWidgetKinds: Type.Optional(
    Type.Array(
      closedObject({
        pluginId: NonEmptyString,
        kind: NonEmptyString,
        label: NonEmptyString,
      }),
    ),
  ),
  pluginSurfaceUrls: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
  auth: closedObject({
    deviceToken: Type.Optional(NonEmptyString),
    role: NonEmptyString,
    scopes: Type.Array(NonEmptyString),
    issuedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    deviceTokens: Type.Optional(
      Type.Array(
        closedObject({
          deviceToken: NonEmptyString,
          role: NonEmptyString,
          scopes: Type.Array(NonEmptyString),
          issuedAtMs: Type.Integer({ minimum: 0 }),
        }),
      ),
    ),
  }),
  policy: closedObject({
    maxPayload: Type.Integer({ minimum: 1 }),
    maxBufferedBytes: Type.Integer({ minimum: 1 }),
    tickIntervalMs: Type.Integer({ minimum: 1 }),
  }),
});

/** Standard structured error shape used in response frames and connect failures. */
export const ErrorShapeSchema = closedObject({
  code: NonEmptyString,
  message: NonEmptyString,
  details: Type.Optional(Type.Unknown()),
  retryable: Type.Optional(Type.Boolean()),
  retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** Client request frame envelope; `method` selects the payload validator. */
export const RequestFrameSchema = closedObject({
  type: Type.Literal("req"),
  id: NonEmptyString,
  method: NonEmptyString,
  params: Type.Optional(Type.Unknown()),
});

/** Server response frame envelope paired with a prior request id. */
export const ResponseFrameSchema = closedObject({
  type: Type.Literal("res"),
  id: NonEmptyString,
  ok: Type.Boolean(),
  payload: Type.Optional(Type.Unknown()),
  error: Type.Optional(ErrorShapeSchema),
});

/** Server event frame envelope; `event` selects the payload validator. */
export const EventFrameSchema = closedObject({
  type: Type.Literal("event"),
  event: NonEmptyString,
  payload: Type.Optional(Type.Unknown()),
  seq: Type.Optional(Type.Integer({ minimum: 0 })),
  stateVersion: Type.Optional(StateVersionSchema),
});

// Discriminated union of all top-level frames. Using a discriminator makes
// downstream codegen (quicktype) produce tighter types instead of all-optional
// blobs.
export const GatewayFrameSchema = Type.Union(
  [RequestFrameSchema, ResponseFrameSchema, EventFrameSchema],
  { discriminator: "type" },
);

// Frame types are owner-local because they cross the public client/plugin SDK.
// Keeping them off the aggregate registry avoids retaining every RPC schema.
export type ConnectParams = Static<typeof ConnectParamsSchema>;
export type HelloOk = Static<typeof HelloOkSchema>;
export type ErrorShape = Static<typeof ErrorShapeSchema>;
export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type EventFrame = Static<typeof EventFrameSchema>;
export type GatewayFrame = Static<typeof GatewayFrameSchema>;

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type TickEvent = Static<typeof TickEventSchema>;
export type ShutdownEvent = Static<typeof ShutdownEventSchema>;
