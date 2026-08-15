// Validation helpers adapt gateway-protocol validators to standard method
// INVALID_REQUEST responses.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ErrorShape, ValidationError } from "../../../packages/gateway-protocol/src/index.js";
import type { RespondFn } from "./types.js";

/** Type guard function shape produced by gateway-protocol validators. */
export type Validator<T> = ((params: unknown) => params is T) & {
  errors?: ValidationError[] | null;
};

/** Validate params and return the standard method error without emitting a response. */
export function validateGatewayMethodParams<T>(
  params: unknown,
  validate: Validator<T>,
  method: string,
): ErrorShape | undefined {
  if (validate(params)) {
    return undefined;
  }
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `invalid ${method} params: ${formatValidationErrors(validate.errors)}`,
  );
}

/** Validate params and emit the standard INVALID_REQUEST response on failure. */
export function assertValidParams<T>(
  params: unknown,
  validate: Validator<T>,
  method: string,
  respond: RespondFn,
): params is T {
  const error = validateGatewayMethodParams(params, validate, method);
  if (!error) {
    return true;
  }
  respond(false, undefined, error);
  return false;
}
