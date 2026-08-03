// Matrix API module exposes the plugin public contract.
export {
  namedAccountPromotionKeys,
  resolveSingleAccountPromotionTarget,
  singleAccountKeysToMove,
} from "./src/setup-contract.js";
export { matrixSetupAdapter } from "./src/setup-core.js";
export { matrixSetupWizard } from "./src/setup-surface.js";
