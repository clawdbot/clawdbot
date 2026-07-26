// Exposes cross-platform permission inspection helpers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Permission inspection facades expose fs-safe POSIX and Windows ACL helpers
// after applying OpenClaw's fs-safe defaults.
export {
  createPrivateDirectory,
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
  readOwnerAndDacl,
  safeStat,
  type OwnerAndDaclResult,
  type PermissionCheck,
  type PermissionCheckOptions,
  type WindowsAccessControlEntry,
} from "@openclaw/fs-safe/permissions";
export {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  type PermissionExec as ExecFn,
} from "@openclaw/fs-safe/advanced";
