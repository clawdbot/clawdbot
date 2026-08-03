// Public facade for config env var collection and durable state-dir dotenv reads.
export {
  cloneEnvWithPlatformSemantics,
  collectConfigRuntimeEnvVars,
  createConfigRuntimeEnv,
  isConfigRuntimeEnvVarAllowed,
} from "./config-env-vars.js";
