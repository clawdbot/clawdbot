// Exposes private temp workspace helpers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Private temp workspaces isolate downloads and generated artifacts under a
// caller-selected temp root with cleanup ownership.
export {
  tempWorkspace,
  tempWorkspaceSync,
  type TempWorkspace,
  type TempWorkspaceOptions,
  type TempWorkspaceSync,
  withTempWorkspace,
  withTempWorkspaceSync,
} from "@openclaw/fs-safe/temp";
