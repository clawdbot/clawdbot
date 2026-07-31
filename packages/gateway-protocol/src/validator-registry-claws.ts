import { lazyCompile } from "./protocol-validator.js";
import {
  ClawLifecycleApplyResultSchema,
  ClawLifecyclePlanResultSchema,
  ClawsAddApplyParamsSchema,
  ClawsAddPlanParamsSchema,
  ClawsCatalogDetailParamsSchema,
  ClawsCatalogDetailResultSchema,
  ClawsCatalogSearchParamsSchema,
  ClawsCatalogSearchResultSchema,
  ClawsDoctorParamsSchema,
  ClawsDoctorResultSchema,
  ClawsRemoveApplyParamsSchema,
  ClawsRemovePlanParamsSchema,
  ClawsStatusParamsSchema,
  ClawsStatusResultSchema,
  ClawsUpdateApplyParamsSchema,
  ClawsUpdatePlanParamsSchema,
} from "./schema-modules.js";

export const validateClawsStatusParams = lazyCompile(ClawsStatusParamsSchema);
export const validateClawsDoctorParams = lazyCompile(ClawsDoctorParamsSchema);
export const validateClawsStatusResult = lazyCompile(ClawsStatusResultSchema);
export const validateClawsDoctorResult = lazyCompile(ClawsDoctorResultSchema);
export const validateClawsCatalogSearchParams = lazyCompile(ClawsCatalogSearchParamsSchema);
export const validateClawsCatalogSearchResult = lazyCompile(ClawsCatalogSearchResultSchema);
export const validateClawsCatalogDetailParams = lazyCompile(ClawsCatalogDetailParamsSchema);
export const validateClawsCatalogDetailResult = lazyCompile(ClawsCatalogDetailResultSchema);
export const validateClawsAddPlanParams = lazyCompile(ClawsAddPlanParamsSchema);
export const validateClawsAddApplyParams = lazyCompile(ClawsAddApplyParamsSchema);
export const validateClawsUpdatePlanParams = lazyCompile(ClawsUpdatePlanParamsSchema);
export const validateClawsUpdateApplyParams = lazyCompile(ClawsUpdateApplyParamsSchema);
export const validateClawsRemovePlanParams = lazyCompile(ClawsRemovePlanParamsSchema);
export const validateClawsRemoveApplyParams = lazyCompile(ClawsRemoveApplyParamsSchema);
export const validateClawLifecyclePlanResult = lazyCompile(ClawLifecyclePlanResultSchema);
export const validateClawLifecycleApplyResult = lazyCompile(ClawLifecycleApplyResultSchema);
