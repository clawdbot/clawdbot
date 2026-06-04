// Lazy runtime barrel for delivery code so command entrypoints can avoid loading
// heavier delivery dependencies until a result must be emitted.
export { deliverAgentCommandResult } from "./delivery.js";
