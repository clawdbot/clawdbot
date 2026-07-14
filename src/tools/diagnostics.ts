/**
 * Diagnostics used when descriptor planning violates tool contract invariants.
 *
 * These are programmer errors, not availability diagnostics, so callers can
 * distinguish broken tool registration from intentionally hidden tools.
 */
/** Stable contract error code emitted by the tool planner. */
type ToolPlanContractErrorCode = "duplicate-tool-name" | "missing-executor";

/** Error thrown when a visible tool plan cannot be built from descriptors. */
export class ToolPlanContractError extends Error {
  readonly code: ToolPlanContractErrorCode;
  readonly toolName: string;

  constructor(params: { code: ToolPlanContractErrorCode; toolName: string; message: string }) {
    super(params.message);
    this.name = "ToolPlanContractError";
    this.code = params.code;
    this.toolName = params.toolName;
  }
}
