import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const ExecApprovalsAllowlistEntrySchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    pattern: Type.String(),
    source: Type.Optional(Type.Literal("allow-always")),
    commandText: Type.Optional(Type.String()),
    argPattern: Type.Optional(Type.String()),
    lastUsedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastUsedCommand: Type.Optional(Type.String()),
    lastResolvedPath: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ExecApprovalsPolicyFields = {
  security: Type.Optional(Type.String()),
  ask: Type.Optional(Type.String()),
  askFallback: Type.Optional(Type.String()),
  autoAllowSkills: Type.Optional(Type.Boolean()),
};

export const ExecApprovalsDefaultsSchema = Type.Object(ExecApprovalsPolicyFields, {
  additionalProperties: false,
});

export const ExecApprovalsAgentSchema = Type.Object(
  {
    ...ExecApprovalsPolicyFields,
    allowlist: Type.Optional(Type.Array(ExecApprovalsAllowlistEntrySchema)),
  },
  { additionalProperties: false },
);

export const ExecApprovalsFileSchema = Type.Object(
  {
    version: Type.Literal(1),
    socket: Type.Optional(
      Type.Object(
        {
          path: Type.Optional(Type.String()),
          token: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    defaults: Type.Optional(ExecApprovalsDefaultsSchema),
    agents: Type.Optional(Type.Record(Type.String(), ExecApprovalsAgentSchema)),
  },
  { additionalProperties: false },
);

export const ExecApprovalsSnapshotSchema = Type.Object(
  {
    path: NonEmptyString,
    exists: Type.Boolean(),
    hash: NonEmptyString,
    file: ExecApprovalsFileSchema,
  },
  { additionalProperties: false },
);

export const ExecApprovalsGetParamsSchema = Type.Object({}, { additionalProperties: false });

export const ExecApprovalsSetParamsSchema = Type.Object(
  {
    file: ExecApprovalsFileSchema,
    baseHash: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ExecApprovalsNodeGetParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ExecApprovalsNodeSetParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    file: ExecApprovalsFileSchema,
    baseHash: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ExecApprovalGetParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ExecApprovalRequestParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    command: Type.Optional(NonEmptyString),
    commandArgv: Type.Optional(Type.Array(Type.String())),
    systemRunPlan: Type.Optional(
      Type.Object(
        {
          argv: Type.Array(Type.String()),
          cwd: Type.Union([Type.String(), Type.Null()]),
          commandText: Type.String(),
          commandPreview: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          agentId: Type.Union([Type.String(), Type.Null()]),
          sessionKey: Type.Union([Type.String(), Type.Null()]),
          mutableFileOperand: Type.Optional(
            Type.Union([
              Type.Object(
                {
                  argvIndex: Type.Integer({ minimum: 0 }),
                  path: Type.String(),
                  sha256: Type.String(),
                },
                { additionalProperties: false },
              ),
              Type.Null(),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
    cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    nodeId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    host: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    security: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ask: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    warningText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    resolvedPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceChannel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    twoPhase: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ExecApprovalResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: NonEmptyString,
  },
  { additionalProperties: false },
);
