/**
 * Core-facing facade for qmd engine availability checks. The package owns the
 * binary probing contract; repo callers import through this stable local path.
 */
export {
  checkQmdBinaryAvailability,
  resolveQmdBinaryUnavailableReason,
} from "../../packages/memory-host-sdk/src/engine-qmd.js";
