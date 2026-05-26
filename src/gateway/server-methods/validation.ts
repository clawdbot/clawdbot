import { ErrorCodes, errorShape, formatValidationErrors } from "../protocol/index.js";
import type { ValidationError } from "../protocol/index.js";
import type { RespondFn } from "./types.js";

export type Validator<T> = ((params: unknown) => params is T) & {
  errors?: ValidationError[] | null;
};

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
