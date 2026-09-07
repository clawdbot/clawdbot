/** Classification belongs to the contract boundary, not error text or tool names.
 * This is diagnostic metadata only, never an effect receipt or retry permission.
 */
export type ToolContractFailureCode = "input_contract" | "output_contract" | "invalid_contract";
const failures = new WeakMap<Error, ToolContractFailureCode>();

export function markToolContractFailure<T extends Error>(
  error: T,
  code: ToolContractFailureCode,
): T {
  failures.set(error, code);
  return error;
}

export function getToolContractFailureCode(error: unknown): ToolContractFailureCode | undefined {
  return error instanceof Error ? failures.get(error) : undefined;
}
