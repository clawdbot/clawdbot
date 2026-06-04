/**
 * Public barrel for descriptor-driven tool planning.
 *
 * Runtime owners import this surface to define tools, evaluate availability,
 * build visible/hidden plans, and convert descriptors to protocol payloads.
 */
export { evaluateToolAvailability } from "./availability.js";
export { defineToolDescriptor, defineToolDescriptors } from "./descriptors.js";
export { ToolPlanContractError } from "./diagnostics.js";
export { formatToolExecutorRef } from "./execution.js";
export { buildToolPlan } from "./planner.js";
export { toToolProtocolDescriptor, toToolProtocolDescriptors } from "./protocol.js";
export type {
  BuildToolPlanOptions,
  HiddenToolPlanEntry,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ToolAvailabilityContext,
  ToolAvailabilityDiagnostic,
  ToolAvailabilityExpression,
  ToolAvailabilitySignal,
  ToolDescriptor,
  ToolExecutorRef,
  ToolOwnerRef,
  ToolPlan,
  ToolPlanEntry,
  ToolUnavailableReason,
} from "./types.js";
