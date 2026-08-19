import type { MemoryAccessContext } from "../memory-host-sdk/host/authorization.js";
import type { MemoryEnterpriseRoleAccessDecision } from "../state/memory-enterprise-access-audit.js";
import type { OpenClawPluginApi } from "./types.js";

/** A host-issued closure for the selected memory plugin's redacted audit writes. */
export type MemoryEnterpriseAccessAuditReporter = Readonly<{
  recordRoleAccessDecisions: (params: {
    context: MemoryAccessContext;
    decisions: readonly MemoryEnterpriseRoleAccessDecision[];
    now?: number;
  }) => void;
}>;

const reporters = new WeakMap<OpenClawPluginApi, MemoryEnterpriseAccessAuditReporter>();

/** Bind the durable writer to one API object after the selected slot is known. */
export function issueMemoryEnterpriseAccessAuditReporter(
  api: OpenClawPluginApi,
  reporter: MemoryEnterpriseAccessAuditReporter,
): void {
  reporters.set(api, reporter);
}

/** Resolve only the reporter that the registry issued to this plugin API object. */
export function resolveMemoryEnterpriseAccessAuditReporter(
  api: OpenClawPluginApi,
): MemoryEnterpriseAccessAuditReporter | undefined {
  return reporters.get(api);
}
