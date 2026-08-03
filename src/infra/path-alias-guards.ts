// Exposes path alias escape guards with fs-safe defaults.
import "./fs-safe-defaults.js";

// Alias guards reject path forms that look local but escape the intended root.
export {
  PATH_ALIAS_POLICIES,
  assertNoPathAliasEscape,
  type PathAliasPolicy,
} from "@openclaw/fs-safe/advanced";
