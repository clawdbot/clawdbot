// Canonical provider/model reference parsing and provider-id normalization.
//
// Split from the `provider-model-shared` barrel, which also value-loads replay
// policy, endpoint, and catalog-compat helpers. Doctor contract closures
// normalize model refs during config migration and doctor enumeration
// cold-loads those closures for every declaring plugin.

export { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
export { parseModelRef } from "../agents/model-selection-normalize.js";
