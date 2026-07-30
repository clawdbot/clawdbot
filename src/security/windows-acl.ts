/** Windows ACL remediation facade backed by shared infra permission policy. */
export {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  type ExecFn,
} from "../infra/permissions.js";
