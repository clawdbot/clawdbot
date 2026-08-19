export * from "./clawhub-trust-error-details.js";
export * from "./install-policy-warning-error-details.js";
export * from "./system-agent-error-details.js";
export {
  ErrorCodes,
  GatewayErrorDetailCodes,
  isMcpAppViewExpiredError,
  readCronJobNotFoundError,
  readMissingScopeError,
  readMissingScopeErrorDetails,
} from "./gateway-error-details.js";
export type {
  CronJobNotFoundErrorDetails,
  GatewayErrorDetails,
  McpAppViewExpiredErrorDetails,
  MissingScopeErrorDetails,
  UserPrefsLimitExceededErrorDetails,
  ProjectCloneErrorDetails,
  ProjectCloneFailureCause,
  WizardNotFoundErrorDetails,
} from "./gateway-error-details.js";
export {
  CronJobNotFoundErrorDetailsSchema,
  GatewayErrorDetailsSchema,
  MissingScopeErrorDetailsSchema,
  UserPrefsLimitExceededErrorDetailsSchema,
  ProjectCloneErrorDetailsSchema,
  WizardNotFoundErrorDetailsSchema,
  buildMissingScopeErrorDetails,
  errorShape,
  missingScopeErrorShape,
} from "./schema/error-codes.js";
