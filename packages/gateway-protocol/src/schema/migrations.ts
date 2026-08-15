// Gateway protocol schemas for reviewed migration surfaces.
import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const MAX_MEMORY_MIGRATION_ITEMS = 2000;
const MemoryMigrationPlanFingerprintSchema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
});

const MemoryMigrationItemStatusSchema = Type.Union([
  Type.Literal("planned"),
  Type.Literal("migrated"),
  Type.Literal("skipped"),
  Type.Literal("warning"),
  Type.Literal("conflict"),
  Type.Literal("error"),
]);

const MemoryMigrationItemSchema = Type.Object(
  {
    id: NonEmptyString,
    status: MemoryMigrationItemStatusSchema,
    source: Type.Optional(NonEmptyString),
    target: Type.Optional(NonEmptyString),
    message: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

const MemoryMigrationSummarySchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    planned: Type.Integer({ minimum: 0 }),
    migrated: Type.Integer({ minimum: 0 }),
    skipped: Type.Integer({ minimum: 0 }),
    conflicts: Type.Integer({ minimum: 0 }),
    errors: Type.Integer({ minimum: 0 }),
    sensitive: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const MemoryMigrationProviderPlanSchema = Type.Object(
  {
    providerId: NonEmptyString,
    label: NonEmptyString,
    description: Type.Optional(Type.String()),
    planFingerprint: Type.Optional(MemoryMigrationPlanFingerprintSchema),
    found: Type.Boolean(),
    source: Type.Optional(NonEmptyString),
    target: Type.Optional(NonEmptyString),
    confidence: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    ),
    message: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    summary: MemoryMigrationSummarySchema,
    items: Type.Array(MemoryMigrationItemSchema, { maxItems: MAX_MEMORY_MIGRATION_ITEMS }),
    warnings: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const MigrationsMemoryPlanParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    overwrite: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const MigrationsMemoryPlanResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    providers: Type.Array(MemoryMigrationProviderPlanSchema),
  },
  { additionalProperties: false },
);

export const MigrationsMemoryApplyParamsSchema = Type.Object(
  {
    idempotencyKey: NonEmptyString,
    agentId: NonEmptyString,
    providerId: NonEmptyString,
    planFingerprint: MemoryMigrationPlanFingerprintSchema,
    itemIds: Type.Array(NonEmptyString, {
      minItems: 1,
      uniqueItems: true,
      maxItems: MAX_MEMORY_MIGRATION_ITEMS,
    }),
    overwrite: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const MigrationsMemoryApplyResultSchema = Type.Object(
  {
    providerId: NonEmptyString,
    source: NonEmptyString,
    target: Type.Optional(NonEmptyString),
    summary: MemoryMigrationSummarySchema,
    items: Type.Array(MemoryMigrationItemSchema, { maxItems: MAX_MEMORY_MIGRATION_ITEMS }),
    warnings: Type.Optional(Type.Array(Type.String())),
    backupPath: Type.Optional(NonEmptyString),
    reportDir: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const MigrationProtocolSchemas = {
  MemoryMigrationItemStatus: MemoryMigrationItemStatusSchema,
  MemoryMigrationItem: MemoryMigrationItemSchema,
  MemoryMigrationSummary: MemoryMigrationSummarySchema,
  MemoryMigrationProviderPlan: MemoryMigrationProviderPlanSchema,
  MigrationsMemoryPlanParams: MigrationsMemoryPlanParamsSchema,
  MigrationsMemoryPlanResult: MigrationsMemoryPlanResultSchema,
  MigrationsMemoryApplyParams: MigrationsMemoryApplyParamsSchema,
  MigrationsMemoryApplyResult: MigrationsMemoryApplyResultSchema,
} as const;

export type MemoryMigrationItem = Static<typeof MemoryMigrationItemSchema>;
export type MemoryMigrationProviderPlan = Static<typeof MemoryMigrationProviderPlanSchema>;
export type MigrationsMemoryPlanResult = Static<typeof MigrationsMemoryPlanResultSchema>;
export type MigrationsMemoryApplyResult = Static<typeof MigrationsMemoryApplyResultSchema>;
