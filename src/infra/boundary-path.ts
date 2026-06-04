// Exposes boundary path resolution helpers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Boundary path resolution keeps alias expansion and realpath checks in one
// shared contract before file IO happens.
export {
  ROOT_PATH_ALIAS_POLICIES,
  resolvePathViaExistingAncestorSync,
  resolveRootPath,
  resolveRootPathSync,
  type ResolvedRootPath,
  type RootPathAliasPolicy,
} from "@openclaw/fs-safe/advanced";
