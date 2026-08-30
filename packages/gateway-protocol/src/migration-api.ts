// Public memory-migration wire contracts and validators.
import { lazyCompile } from "./protocol-validator.js";
import {
  MigrationsMemoryApplyParamsSchema,
  MigrationsMemoryPlanParamsSchema,
} from "./schema/migrations.js";

export * from "./schema/migrations.js";

export const validateMigrationsMemoryPlanParams = lazyCompile(MigrationsMemoryPlanParamsSchema);
export const validateMigrationsMemoryApplyParams = lazyCompile(MigrationsMemoryApplyParamsSchema);
