/** Filesystem permission audit facade backed by shared infra permission helpers. */
export {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
  safeStat,
  type PermissionCheck,
  type PermissionCheckOptions,
} from "../infra/permissions.js";
