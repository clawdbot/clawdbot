import { errorShape } from "../../packages/gateway-protocol/src/index.js";
import { copyErrorDiagnostic } from "../infra/error-diagnostics.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";

/** Builds a wire error from an unknown failure without diagnostic class names. */
export function errorShapeFromError(
  code: Parameters<typeof errorShape>[0],
  error: unknown,
  opts?: Parameters<typeof errorShape>[2],
) {
  const shape = errorShape(code, formatErrorMessageWithCode(error), opts);
  copyErrorDiagnostic(error, shape);
  return shape;
}
