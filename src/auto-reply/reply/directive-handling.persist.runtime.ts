/** Runtime facade for persisting inline directive state after parsing. */
export { persistInlineDirectives } from "./directive-handling.persist.js";
// This facade is the lazy boundary used by get-reply's directive-only fast path.
export { applySessionModelSelection } from "../../model-picker/apply-session-model-selection.js";
