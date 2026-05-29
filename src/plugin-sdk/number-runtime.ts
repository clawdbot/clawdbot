// Numeric coercion helpers for plugin runtime inputs.

export {
  parseFiniteNumber,
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
  parseStrictInteger,
  parseStrictFiniteNumber,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "../shared/number-coercion.js";
export { MAX_TCP_PORT, parseTcpPort } from "../infra/tcp-port.js";
