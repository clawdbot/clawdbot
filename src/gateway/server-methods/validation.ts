// Validation helpers adapt gateway-protocol validators to standard method
// INVALID_REQUEST responses.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  ErrorShape,
  GatewayCoreRequestParams,
  ValidationError,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

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

/** Bind a core method to its schema before exposing it through the open plugin registry. */
export function defineValidatedGatewayMethod<Method extends keyof GatewayCoreRequestParams>(
  method: Method,
  validate: Validator<NoInfer<GatewayCoreRequestParams[Method]>>,
  handler: (
    options: Omit<GatewayRequestHandlerOptions, "params"> & {
      params: GatewayCoreRequestParams[Method];
    },
  ) => ReturnType<GatewayRequestHandler>,
): GatewayRequestHandler {
  return (options) => {
    if (!assertValidParams(options.params, validate, method, options.respond)) {
      return;
    }
    return handler({ ...options, params: options.params });
  };
}
