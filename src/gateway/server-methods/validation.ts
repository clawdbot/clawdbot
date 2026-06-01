import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ValidationError } from "../../../packages/gateway-protocol/src/index.js";
import type { RespondFn } from "./types.js";

/** Type guard function shape produced by gateway-protocol validators. */
export type Validator<T> = ((params: unknown) => params is T) & {
  errors?: ValidationError[] | null;
};

/** Validate params and emit the standard INVALID_REQUEST response on failure. */
export function assertValidParams<T>(
  params: unknown,
  validate: Validator<T>,
  method: string,
  respond: RespondFn,
): params is T {
  if (validate(params)) {
    return true;
  }
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(validate.errors)}`,
    ),
  );
  return false;
}
