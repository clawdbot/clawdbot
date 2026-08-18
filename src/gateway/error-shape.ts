import { errorShape } from "../../packages/gateway-protocol/src/index.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";

/** Builds a wire error from an unknown failure without diagnostic class names. */
export function errorShapeFromError(
  code: Parameters<typeof errorShape>[0],
  error: unknown,
  opts?: Parameters<typeof errorShape>[2],
) {
  return errorShape(code, formatErrorMessageWithCode(error), opts);
}
