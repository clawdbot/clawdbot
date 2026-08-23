import { AsyncLocalStorage } from "node:async_hooks";

type ToolExecutionValidator = (params: unknown) => void | Promise<void>;
type ScopedToolExecutionValidator = {
  toolCallId: string;
  validate: ToolExecutionValidator;
};

const executionValidators = new AsyncLocalStorage<ScopedToolExecutionValidator>();
const INTERNAL_TOOL_EXECUTION_VALIDATION = Symbol.for("openclaw.internalToolExecutionValidation");

type InternalToolExecutionValidation = {
  toolCallId: string;
  validate: ToolExecutionValidator;
};

/** Keep per-call validation inside the policy wrapper's final execution boundary. */
export async function runWithToolExecutionValidation<T>(
  toolCallId: string,
  validator: ToolExecutionValidator,
  execute: () => Promise<T>,
): Promise<T> {
  return await executionValidators.run({ toolCallId, validate: validator }, execute);
}

/** Validate hook-adjusted arguments without leaking a validator into concurrent calls. */
export async function validateToolExecutionParams(
  toolCallId: string,
  params: unknown,
): Promise<void> {
  const scopedValidator = executionValidators.getStore();
  if (scopedValidator?.toolCallId === toolCallId) {
    await scopedValidator.validate(params);
  }
}

/** Read the private validation control carried by one native harness call. */
export function readInternalToolExecutionValidation(
  value: unknown,
): InternalToolExecutionValidation | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const marker = Reflect.get(value, INTERNAL_TOOL_EXECUTION_VALIDATION);
  const toolCallId = Reflect.get(value, "toolCallId");
  const validate = Reflect.get(value, "validate");
  if (marker !== true || typeof toolCallId !== "string" || typeof validate !== "function") {
    return undefined;
  }
  return {
    toolCallId,
    validate: async (params) => {
      await Reflect.apply(validate, undefined, [params]);
    },
  };
}
