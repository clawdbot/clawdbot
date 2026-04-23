import { Type } from "typebox";
import { GatewayClientIdSchema, GatewayClientModeSchema, NonEmptyString } from "./primitives.js";
import { SnapshotSchema, StateVersionSchema } from "./snapshot.js";

export const TickEventSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ShutdownEventSchema = Type.Object(
  {
    reason: NonEmptyString,
    restartExpectedMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ConnectParamsSchema = Type.Object(
  {
    minProtocol: Type.Integer({ minimum: 1 }),
    maxProtocol: Type.Integer({ minimum: 1 }),
    client: Type.Object(
      {
        id: GatewayClientIdSchema,
        displayName: Type.Optional(NonEmptyString),
        version: NonEmptyString,
        platform: NonEmptyString,
        deviceFamily: Type.Optional(NonEmptyString),
        modelIdentifier: Type.Optional(NonEmptyString),
        mode: GatewayClientModeSchema,
        instanceId: Type.Optional(NonEmptyString),
      },
      { additionalProperties: false },
    ),
    caps: Type.Optional(Type.Array(NonEmptyString, { default: [] })),
    commands: Type.Optional(Type.Array(NonEmptyString)),
    permissions: Type.Optional(Type.Record(NonEmptyString, Type.Boolean())),
    pathEnv: Type.Optional(Type.String()),
    role: Type.Optional(NonEmptyString),
    scopes: Type.Optional(Type.Array(NonEmptyString)),
    device: Type.Optional(
      Type.Object(
        {
          id: NonEmptyString,
          publicKey: NonEmptyString,
          signature: NonEmptyString,
          signedAt: Type.Integer({ minimum: 0 }),
          nonce: NonEmptyString,
        },
        { additionalProperties: false },
      ),
    ),
    auth: Type.Optional(
      Type.Object(
        {
          token: Type.Optional(Type.String()),
          bootstrapToken: Type.Optional(Type.String()),
          deviceToken: Type.Optional(Type.String()),
          password: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    locale: Type.Optional(Type.String()),
    userAgent: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const HelloOkSchema = Type.Object(
  {
    type: Type.Literal("hello-ok"),
    protocol: Type.Integer({ minimum: 1 }),
    server: Type.Object(
      {
        version: NonEmptyString,
        connId: NonEmptyString,
      },
      { additionalProperties: false },
    ),
    features: Type.Object(
      {
        methods: Type.Array(NonEmptyString),
        events: Type.Array(NonEmptyString),
      },
      { additionalProperties: false },
    ),
    snapshot: SnapshotSchema,
    canvasHostUrl: Type.Optional(NonEmptyString),
    auth: Type.Optional(
      Type.Object(
        {
          deviceToken: Type.Optional(NonEmptyString),
          role: NonEmptyString,
          scopes: Type.Array(NonEmptyString),
          issuedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
          deviceTokens: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  deviceToken: NonEmptyString,
                  role: NonEmptyString,
                  scopes: Type.Array(NonEmptyString),
                  issuedAtMs: Type.Integer({ minimum: 0 }),
                },
                { additionalProperties: false },
              ),
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    policy: Type.Object(
      {
        maxPayload: Type.Integer({ minimum: 1 }),
        maxBufferedBytes: Type.Integer({ minimum: 1 }),
        tickIntervalMs: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ErrorShapeSchema = Type.Object(
  {
    code: NonEmptyString,
    message: NonEmptyString,
    details: Type.Optional(Type.Unknown()),
    retryable: Type.Optional(Type.Boolean()),
    retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const RequestFrameSchema = Type.Object(
  {
    type: Type.Literal("req"),
    id: NonEmptyString,
    method: NonEmptyString,
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ResponseFrameSchema = Type.Object(
  {
    type: Type.Literal("res"),
    id: NonEmptyString,
    ok: Type.Boolean(),
    payload: Type.Optional(Type.Unknown()),
    error: Type.Optional(ErrorShapeSchema),
  },
  { additionalProperties: false },
);

export const EventFrameSchema = Type.Object(
  {
    type: Type.Literal("event"),
    event: NonEmptyString,
    payload: Type.Optional(Type.Unknown()),
    seq: Type.Optional(Type.Integer({ minimum: 0 })),
    stateVersion: Type.Optional(StateVersionSchema),
  },
  { additionalProperties: false },
);

// Discriminated union of all top-level frames. Using a discriminator makes
// downstream codegen (quicktype) produce tighter types instead of all-optional
// blobs.
export const GatewayFrameSchema = Type.Union(
  [RequestFrameSchema, ResponseFrameSchema, EventFrameSchema],
  { discriminator: "type" },
);
