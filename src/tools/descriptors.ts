// Defines built-in tool descriptors exposed to model planning.
import type { ToolDescriptor } from "./types.js";

/**
 * Identity helpers for authoring tool descriptors with stable inferred types.
 *
 * Callers use these at declaration sites so descriptor arrays keep readonly
 * shapes while still validating against the public ToolDescriptor contract.
 */
/** Define one tool descriptor without changing its runtime shape. */
export function defineToolDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  return descriptor;
}

/** Define a readonly descriptor list without changing runtime order or entries. */
export function defineToolDescriptors(
  descriptors: readonly ToolDescriptor[],
): readonly ToolDescriptor[] {
  return descriptors;
}
