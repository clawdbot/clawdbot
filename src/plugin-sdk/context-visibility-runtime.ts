// Narrow context visibility helpers without broad config-runtime imports.

export {
  resolveChannelContextVisibilityMode,
  resolveDefaultContextVisibility,
} from "../config/context-visibility.js";
export {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
  type ContextVisibilityDecision,
  type ContextVisibilityDecisionReason,
  type ContextVisibilityKind,
} from "../security/context-visibility.js";
