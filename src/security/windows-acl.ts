/** Windows ACL audit facade backed by shared infra permission helpers. */
export {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  formatWindowsAclSummary,
  inspectWindowsAcl,
  parseIcaclsOutput,
  resolveWindowsUserPrincipal,
  summarizeWindowsAcl,
  type ExecFn,
  type WindowsAclEntry,
  type WindowsAclSummary,
} from "../infra/permissions.js";
