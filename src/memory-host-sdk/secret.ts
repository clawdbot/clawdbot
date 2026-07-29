/**
 * Memory secret input facade. The shared SDK package owns accepted secret
 * shapes; core uses this path for config/status checks.
 */
export {
  hasConfiguredMemorySecretInput,
  resolveMemorySecretInputString,
} from "../../packages/memory-host-sdk/src/secret.js";
