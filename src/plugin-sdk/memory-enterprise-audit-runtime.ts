/**
 * This resolver has no writer of its own. The registry binds a reporter to the
 * selected memory plugin's API object, so importing this module cannot grant
 * another plugin enterprise-audit authority.
 */
export {
  resolveMemoryEnterpriseAccessAuditReporter,
  type MemoryEnterpriseAccessAuditReporter,
} from "../plugins/memory-enterprise-access-audit-reporter.js";
