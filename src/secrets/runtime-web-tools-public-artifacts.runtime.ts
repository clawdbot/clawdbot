/**
 * Lazy public-artifact facade for bundled web provider metadata used by secrets runtime.
 * This boundary avoids loading plugin packages just to inspect web tool surfaces.
 */
export {
  resolveBundledWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebSearchProvidersFromPublicArtifacts,
} from "../plugins/web-provider-public-artifacts.js";
