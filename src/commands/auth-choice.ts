// Public auth-choice barrel used by onboarding and agent setup commands.
export { applyAuthChoice, prepareAuthChoice } from "./auth-choice.apply.js";
export {
  resolveDefaultModelCatalogFacts,
  resolveDefaultModelAuthStatus,
  warnIfModelConfigLooksOff,
} from "./auth-choice.model-check.js";
export { resolvePreferredProviderForAuthChoice } from "../plugins/provider-auth-choice-preference.js";
